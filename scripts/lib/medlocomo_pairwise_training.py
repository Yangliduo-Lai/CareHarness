#!/usr/bin/env python3
"""Offline patient-disjoint pairwise Admission/Turn ranker prototype.

Reads CareHarness' MedLoCoMo full-distillation shards, but deliberately uses only:
  * question/type/scope as runtime inputs,
  * source admission metadata and source turn text as runtime candidates,
  * official admission/turn evidence as positive training labels,
  * same-patient teacher hard-negative refs and lexical negatives for mining.

No output is written under the repository. The report is written under /private/tmp.
Compatible with the old system Python + NumPy available in this workspace.
"""
from __future__ import print_function

import argparse
import collections
import datetime
import hashlib
import json
import math
import os
import re
import sys
import time

import numpy as np


HOLDOUT = ('10913302', '11021643', '11441519', '11826927')
TYPES = (
    'adversarial',
    'care_plan_rationale',
    'cross_admission_comparison',
    'frequency_pattern',
    'longitudinal_progression',
    'medical_reasoning',
)
TYPE_INDEX = dict((name, i) for i, name in enumerate(TYPES))
STOP = set(('a an the and or of for to in on at by as was were is are be been being with '
            'from during which what when where why how did does do had has have his her their '
            'this that these those into after before over time patient hospitalization '
            'hospitalizations admission admissions across multiple because due while most '
            'primary main following according record records tell describe explain compare '
            'between regarding related').split())
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?", re.I)
DATE_RE = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')
EARLY_RE = re.compile(r'\b(initial(?:ly)?|earliest|first|at first|baseline|on presentation)\b', re.I)
LATE_RE = re.compile(r'\b(final(?:ly)?|latest|last|eventually|ultimately|at discharge|outcome)\b', re.I)
NEGATIONS = set(('no not never none without denied denies negative absent cannot unable unlikely').split())

ADMISSION_FEATURES = (
    'adm_bm25_log',
    'best_turn_bm25_log',
    'top3_turn_bm25_log',
    'adm_tfidf_cosine',
    'best_turn_tfidf_cosine',
    'adm_idf_query_coverage',
    'best_turn_idf_query_coverage',
    'stem_query_coverage',
    'prefix_query_coverage',
    'query_bigram_coverage',
    'clinical_number_coverage',
    'explicit_date_interval_overlap',
    'explicit_date_boundary_match',
    'doctor_best_bm25_log',
    'patient_best_bm25_log',
    'cue_conditioned_temporal_position',
    'negation_coverage',
    'log_turn_count',
)

TURN_FEATURES = (
    'turn_bm25_log',
    'turn_tfidf_cosine',
    'turn_idf_query_coverage',
    'turn_stem_query_coverage',
    'turn_prefix_query_coverage',
    'turn_query_bigram_coverage',
    'turn_clinical_number_coverage',
    'local_context_bm25_log',
    'local_context_idf_query_coverage',
    'doctor_speaker',
    'patient_speaker',
    'cue_conditioned_turn_position',
    'negation_coverage',
    'log_token_count',
)


def tokens(text):
    return TOKEN_RE.findall((text or '').lower())


def content_tokens(text):
    return [x for x in tokens(text) if x not in STOP and (len(x) > 1 or x.isdigit())]


def stem(token):
    if token.isdigit() or len(token) < 5:
        return token
    if token.endswith('ies') and len(token) > 5:
        return token[:-3] + 'y'
    for suffix in ('ingly', 'edly', 'ing', 'ed'):
        if token.endswith(suffix) and len(token) > len(suffix) + 3:
            return token[:-len(suffix)]
    if token.endswith('es') and len(token) > 6:
        return token[:-2]
    if token.endswith('s') and len(token) > 6 and not token.endswith(('sis', 'ous')):
        return token[:-1]
    return token


def bigrams(seq):
    return set(zip(seq, seq[1:])) if len(seq) > 1 else set()


def parse_date(value):
    try:
        return datetime.datetime.strptime((value or '')[:10], '%Y-%m-%d').date()
    except (ValueError, TypeError):
        return None


def percentile90(values):
    if not values:
        return 1
    vals = sorted(values)
    return int(vals[int(math.ceil(0.9 * len(vals))) - 1])


def operation(case):
    qtype = case.get('task', {}).get('question_type', '')
    q = case.get('task', {}).get('question', '').lower()
    if qtype == 'adversarial':
        return 'answerability_check'
    if qtype == 'frequency_pattern':
        return 'count_occurrences' if re.search(r'\b(how many|number of|how often|times?|episodes?)\b', q) else 'frequency_extremum'
    if qtype == 'longitudinal_progression':
        return 'endpoint_outcome' if re.search(r'\b(final|outcome|became|developed|evolved|progressed|resolved|ultimately|eventually)\b', q) else 'ordered_progression'
    return qtype


def question_info(text):
    raw = tokens(text)
    qterms = [x for x in raw if x not in STOP and (len(x) > 1 or x.isdigit())]
    qset = set(qterms)
    qstems = set(stem(x) for x in qterms)
    qpfx = set(x[:5] for x in qterms if len(x) >= 5)
    qbig = bigrams(qterms)
    dates = [parse_date(x) for x in DATE_RE.findall(text or '')]
    dates = [x for x in dates if x is not None]
    date_numbers = set()
    for d in DATE_RE.findall(text or ''):
        date_numbers.update(TOKEN_RE.findall(d))
    nums = set(x for x in qterms if re.match(r'^\d', x) and x not in date_numbers and len(x) < 4)
    early = bool(EARLY_RE.search(text or ''))
    late = bool(LATE_RE.search(text or ''))
    return {
        'text': text or '', 'terms': qterms, 'set': qset, 'stems': qstems,
        'prefixes': qpfx, 'bigrams': qbig, 'dates': dates, 'numbers': nums,
        'early': early, 'late': late, 'neg': qset.intersection(NEGATIONS),
    }


def compact_patient(raw, idf, avg_adm_len, avg_turn_len):
    turn_by_ref = {}
    turns_by_adm = collections.defaultdict(list)
    for row in raw.get('source_turns', []):
        ref = str(row.get('source_ref', ''))
        seq = content_tokens(row.get('text', ''))
        cnt = collections.Counter(seq)
        st = set(stem(x) for x in seq)
        pfx = set(x[:5] for x in seq if len(x) >= 5)
        item = {
            'ref': ref,
            'admission_id': str(row.get('admission_id', '')),
            'number': int(row.get('turn_number', 0) or 0),
            'speaker': str(row.get('speaker', '')).lower(),
            'time': str(row.get('time', '')),
            'seq': seq,
            'cnt': cnt,
            'len': len(seq),
            'set': set(cnt),
            'stems': st,
            'prefixes': pfx,
            'bigrams': bigrams(seq),
        }
        item['norm'] = tfidf_norm(cnt, idf)
        turn_by_ref[ref] = item
        turns_by_adm[item['admission_id']].append(item)
    admissions = {}
    rows = sorted(raw.get('admissions', []), key=lambda x: int(x.get('admission_order', 0) or 0))
    total = max(1, len(rows) - 1)
    for pos, row in enumerate(rows):
        aid = str(row.get('admission_id', ''))
        trs = turns_by_adm.get(aid, [])
        seq = []
        for tr in trs:
            seq.extend(tr['seq'])
        cnt = collections.Counter(seq)
        admissions[aid] = {
            'id': aid,
            'order': int(row.get('admission_order', pos + 1) or pos + 1),
            'position': float(pos) / total,
            'start': parse_date(row.get('admission_start', '')),
            'end': parse_date(row.get('admission_end', '')),
            'turns': trs,
            'cnt': cnt,
            'len': len(seq),
            'set': set(cnt),
            'stems': set(stem(x) for x in cnt),
            'prefixes': set(x[:5] for x in cnt if len(x) >= 5),
            'bigrams': bigrams(seq),
        }
        admissions[aid]['norm'] = tfidf_norm(cnt, idf)
    return admissions, turn_by_ref


def bm25(qterms, doc, idf, avg_len, k1=1.2, b=0.72):
    if not qterms or not doc['len']:
        return 0.0
    score = 0.0
    norm = k1 * (1.0 - b + b * float(doc['len']) / max(1.0, avg_len))
    for term in set(qterms):
        tf = doc['cnt'].get(term, 0)
        if tf:
            score += idf.get(term, idf.get('__default__', 1.0)) * tf * (k1 + 1.0) / (tf + norm)
    return score


def tfidf_norm(counter, idf):
    value = 0.0
    default = idf.get('__default__', 1.0)
    for term, count in counter.items():
        weight = (1.0 + math.log(count)) * idf.get(term, default)
        value += weight * weight
    return math.sqrt(value)


def cosine(qinfo, doc, idf):
    if not qinfo['terms'] or not doc['norm']:
        return 0.0
    qcnt = collections.Counter(qinfo['terms'])
    dot = 0.0
    qnorm = 0.0
    default = idf.get('__default__', 1.0)
    for term, count in qcnt.items():
        qw = (1.0 + math.log(count)) * idf.get(term, default)
        dw = (1.0 + math.log(doc['cnt'][term])) * idf.get(term, default) if doc['cnt'].get(term) else 0.0
        dot += qw * dw
        qnorm += qw * qw
    return dot / max(1e-9, math.sqrt(qnorm) * doc['norm'])


def weighted_coverage(qinfo, present, idf):
    if not qinfo['set']:
        return 0.0
    default = idf.get('__default__', 1.0)
    denom = sum(idf.get(x, default) for x in qinfo['set'])
    numer = sum(idf.get(x, default) for x in qinfo['set'] if x in present)
    return numer / max(1e-9, denom)


def fraction_overlap(wanted, present):
    return float(len(wanted.intersection(present))) / len(wanted) if wanted else 0.0


def temporal_feature(qinfo, position):
    if qinfo['early'] and not qinfo['late']:
        return 1.0 - position
    if qinfo['late'] and not qinfo['early']:
        return position
    return 0.0


def date_features(qinfo, adm):
    if not qinfo['dates'] or not adm['start'] or not adm['end']:
        return 0.0, 0.0
    low, high = min(qinfo['dates']), max(qinfo['dates'])
    overlap = float(adm['start'] <= high and adm['end'] >= low)
    boundary = sum(float(x in qinfo['dates']) for x in (adm['start'], adm['end'])) / 2.0
    return overlap, boundary


def admission_features(qinfo, adm, idf, avg_adm_len, avg_turn_len):
    a_bm = bm25(qinfo['terms'], adm, idf, avg_adm_len)
    rows = []
    doctor = []
    patient = []
    for tr in adm['turns']:
        tbm = bm25(qinfo['terms'], tr, idf, avg_turn_len)
        cov = weighted_coverage(qinfo, tr['set'], idf)
        co = cosine(qinfo, tr, idf)
        rows.append((tbm, cov, co))
        if 'doctor' in tr['speaker'] or 'clinician' in tr['speaker']:
            doctor.append(tbm)
        if 'patient' in tr['speaker']:
            patient.append(tbm)
    bmvals = sorted((x[0] for x in rows), reverse=True)
    best_bm = bmvals[0] if bmvals else 0.0
    top3_bm = sum(bmvals[:3]) / min(3, len(bmvals)) if bmvals else 0.0
    best_cov = max((x[1] for x in rows), default=0.0)
    best_cos = max((x[2] for x in rows), default=0.0)
    date_overlap, date_boundary = date_features(qinfo, adm)
    return np.asarray([
        math.log1p(a_bm),
        math.log1p(best_bm),
        math.log1p(top3_bm),
        cosine(qinfo, adm, idf),
        best_cos,
        weighted_coverage(qinfo, adm['set'], idf),
        best_cov,
        fraction_overlap(qinfo['stems'], adm['stems']),
        fraction_overlap(qinfo['prefixes'], adm['prefixes']),
        fraction_overlap(qinfo['bigrams'], adm['bigrams']),
        fraction_overlap(qinfo['numbers'], set(x for x in adm['set'] if re.match(r'^\d', x))),
        date_overlap,
        date_boundary,
        math.log1p(max(doctor) if doctor else 0.0),
        math.log1p(max(patient) if patient else 0.0),
        temporal_feature(qinfo, adm['position']),
        fraction_overlap(qinfo['neg'], adm['set']),
        math.log1p(len(adm['turns'])),
    ], dtype=np.float32)


def merged_doc(turns, idf):
    seq = []
    for tr in turns:
        seq.extend(tr['seq'])
    cnt = collections.Counter(seq)
    return {'seq': seq, 'cnt': cnt, 'len': len(seq), 'set': set(cnt),
            'stems': set(stem(x) for x in cnt),
            'prefixes': set(x[:5] for x in cnt if len(x) >= 5),
            'bigrams': bigrams(seq), 'norm': tfidf_norm(cnt, idf)}


def turn_features(qinfo, turn, admission, idf, avg_turn_len):
    turns = admission['turns']
    idx = next((i for i, x in enumerate(turns) if x['ref'] == turn['ref']), 0)
    local = merged_doc(turns[max(0, idx - 1):min(len(turns), idx + 2)], idf)
    pos = float(idx) / max(1, len(turns) - 1)
    nums = set(x for x in turn['set'] if re.match(r'^\d', x))
    speaker = turn['speaker']
    return np.asarray([
        math.log1p(bm25(qinfo['terms'], turn, idf, avg_turn_len)),
        cosine(qinfo, turn, idf),
        weighted_coverage(qinfo, turn['set'], idf),
        fraction_overlap(qinfo['stems'], turn['stems']),
        fraction_overlap(qinfo['prefixes'], turn['prefixes']),
        fraction_overlap(qinfo['bigrams'], turn['bigrams']),
        fraction_overlap(qinfo['numbers'], nums),
        math.log1p(bm25(qinfo['terms'], local, idf, avg_turn_len * 3.0)),
        weighted_coverage(qinfo, local['set'], idf),
        float('doctor' in speaker or 'clinician' in speaker),
        float('patient' in speaker),
        temporal_feature(qinfo, pos),
        fraction_overlap(qinfo['neg'], turn['set']),
        math.log1p(turn['len']),
    ], dtype=np.float32)


def current_like_admission_score(x):
    # Mirrors the shape of the current evaluator: best turn + .35 second + .15 third.
    return float(x[1] + 0.35 * x[2] + 0.20 * x[9] + 4.0 * x[11] + 2.0 * x[12])


def current_like_turn_score(x):
    return float(x[0] + 0.25 * x[5] + 0.10 * x[7])


def official(case):
    ev = case.get('supervision', {}).get('official_evidence', {})
    return ([str(x) for x in ev.get('admission_ids', [])],
            [str(x) for x in ev.get('turn_refs', [])])


def hard_negative_refs(case):
    return [str(x.get('source_ref', '')) for x in case.get('retrieval_teacher', {}).get('hard_negatives', [])]


def deterministic_inner_dev(patient_id):
    # 12 of 97 patients, committed independently of outcomes.
    value = int(hashlib.sha256(('pairwise-inner-dev-v1:' + patient_id).encode('utf8')).hexdigest()[:8], 16)
    return value % 8 == 0


def load_json(path):
    with open(path, 'r') as handle:
        return json.load(handle)


def build_idf(root, train_ids):
    df = collections.Counter()
    lengths = []
    turn_lengths = []
    for n, pid in enumerate(train_ids):
        raw = load_json(os.path.join(root, 'patients', pid + '.json'))
        by_adm = collections.defaultdict(list)
        for tr in raw.get('source_turns', []):
            seq = content_tokens(tr.get('text', ''))
            by_adm[str(tr.get('admission_id', ''))].extend(seq)
            turn_lengths.append(len(seq))
        for adm in raw.get('admissions', []):
            seq = by_adm.get(str(adm.get('admission_id', '')), [])
            lengths.append(len(seq))
            df.update(set(seq))
        if (n + 1) % 20 == 0:
            print('idf_pass', n + 1, '/', len(train_ids), file=sys.stderr, flush=True)
    ndocs = len(lengths)
    idf = dict((term, math.log(1.0 + (ndocs - freq + 0.5) / (freq + 0.5))) for term, freq in df.items())
    idf['__default__'] = math.log(1.0 + (ndocs + 0.5) / 0.5)
    return idf, float(sum(lengths)) / max(1, len(lengths)), float(sum(turn_lengths)) / max(1, len(turn_lengths)), ndocs


def case_budget(case, budgets, admission_count):
    scope = case.get('task', {}).get('scope', '')
    if scope == 'single_admission':
        return 1
    key = (case.get('task', {}).get('question_type', ''), operation(case))
    return min(admission_count, max(2, budgets.get(key, 4)))


def pairwise_fit(diffs, type_ids, sample_weights, mask=None, global_l2=0.02,
                 type_l2=0.12, steps=140, learning_rate=0.045):
    if mask is not None:
        d = diffs[mask]
        tids = type_ids[mask]
        sw = sample_weights[mask]
    else:
        d, tids, sw = diffs, type_ids, sample_weights
    scale = np.sqrt(np.average(d * d, axis=0, weights=sw)).astype(np.float32)
    scale[scale < 1e-4] = 1.0
    zdata = d / scale
    wg = np.zeros(d.shape[1], dtype=np.float64)
    mt = np.zeros_like(wg)
    vt = np.zeros_like(wg)
    swsum = float(sw.sum())
    for step in range(steps):
        z = np.dot(zdata, wg)
        p = 1.0 / (1.0 + np.exp(np.clip(z, -35, 35)))
        grad = -np.sum(zdata * (p * sw)[:, None], axis=0) / max(1e-9, swsum) + global_l2 * wg
        mt = 0.9 * mt + 0.1 * grad
        vt = 0.999 * vt + 0.001 * grad * grad
        mhat = mt / (1.0 - 0.9 ** (step + 1))
        vhat = vt / (1.0 - 0.999 ** (step + 1))
        wg -= learning_rate * mhat / (np.sqrt(vhat) + 1e-8)
    wt = np.zeros((len(TYPES), d.shape[1]), dtype=np.float64)
    for tid in range(len(TYPES)):
        sel = tids == tid
        if not np.any(sel):
            continue
        td, tw = zdata[sel], sw[sel]
        w = np.zeros(d.shape[1], dtype=np.float64)
        mt = np.zeros_like(w)
        vt = np.zeros_like(w)
        denom = float(tw.sum())
        for step in range(steps):
            z = np.dot(td, wg + w)
            p = 1.0 / (1.0 + np.exp(np.clip(z, -35, 35)))
            grad = -np.sum(td * (p * tw)[:, None], axis=0) / max(1e-9, denom) + type_l2 * w
            mt = 0.9 * mt + 0.1 * grad
            vt = 0.999 * vt + 0.001 * grad * grad
            mhat = mt / (1.0 - 0.9 ** (step + 1))
            vhat = vt / (1.0 - 0.999 ** (step + 1))
            w -= learning_rate * mhat / (np.sqrt(vhat) + 1e-8)
        wt[tid] = w
    return {'scale': scale, 'global': wg, 'type': wt, 'global_l2': global_l2,
            'type_l2': type_l2, 'steps': steps, 'learning_rate': learning_rate}


def model_scores(model, x, tid):
    return np.dot(x / model['scale'], model['global'] + model['type'][tid])


def baseline_scores(x, mode):
    if mode == 'admission':
        return np.asarray([current_like_admission_score(row) for row in x])
    return np.asarray([current_like_turn_score(row) for row in x])


def make_training_data(root, train_ids, idf, avg_adm_len, avg_turn_len):
    adiffs, atypes, aweights, apids = [], [], [], []
    tdiffs, ttypes, tweights, tpids = [], [], [], []
    budget_values = collections.defaultdict(list)
    stats = collections.Counter()
    for pidx, pid in enumerate(train_ids):
        raw = load_json(os.path.join(root, 'patients', pid + '.json'))
        admissions, turn_by_ref = compact_patient(raw, idf, avg_adm_len, avg_turn_len)
        aid_list = list(admissions)
        for case in raw.get('cases', []):
            qtype = case.get('task', {}).get('question_type', '')
            if qtype not in TYPE_INDEX:
                continue
            tid = TYPE_INDEX[qtype]
            qinfo = question_info(case.get('task', {}).get('question', ''))
            pos_a, pos_t = official(case)
            pos_a = [x for x in pos_a if x in admissions]
            pos_t = [x for x in pos_t if x in turn_by_ref]
            budget_values[(qtype, operation(case))].append(len(pos_a))
            if pos_a:
                positive = set(pos_a)
                quick = []
                for aid in aid_list:
                    if aid not in positive:
                        quick.append((bm25(qinfo['terms'], admissions[aid], idf, avg_adm_len), aid))
                quick.sort(reverse=True)
                teacher_a = []
                for ref in hard_negative_refs(case):
                    tr = turn_by_ref.get(ref)
                    if tr and tr['admission_id'] not in positive and tr['admission_id'] not in teacher_a:
                        teacher_a.append(tr['admission_id'])
                negatives = teacher_a[:5]
                for _, aid in quick:
                    if aid not in negatives:
                        negatives.append(aid)
                    if len(negatives) >= 10:
                        break
                selected = list(dict.fromkeys(pos_a + negatives))
                feats = dict((aid, admission_features(qinfo, admissions[aid], idf, avg_adm_len, avg_turn_len)) for aid in selected)
                denom = max(1, len(pos_a) * len(negatives))
                for pa in pos_a:
                    for na in negatives:
                        adiffs.append(feats[pa] - feats[na])
                        atypes.append(tid)
                        aweights.append(1.0 / denom)
                        apids.append(pidx)
                stats['admission_cases'] += 1
                stats['admission_pairs'] += len(pos_a) * len(negatives)
            if pos_t:
                positives = set(pos_t)
                candidate_refs = []
                for aid in pos_a:
                    candidate_refs.extend(x['ref'] for x in admissions[aid]['turns'])
                teacher_refs = [x for x in hard_negative_refs(case) if x in turn_by_ref and x not in positives]
                quick = []
                for ref in candidate_refs:
                    if ref not in positives:
                        tr = turn_by_ref[ref]
                        quick.append((bm25(qinfo['terms'], tr, idf, avg_turn_len), ref))
                quick.sort(reverse=True)
                negatives = teacher_refs[:5]
                for _, ref in quick:
                    if ref not in negatives:
                        negatives.append(ref)
                    if len(negatives) >= 14:
                        break
                selected = list(dict.fromkeys(pos_t + negatives))
                feats = {}
                for ref in selected:
                    tr = turn_by_ref[ref]
                    adm = admissions.get(tr['admission_id'])
                    if adm is not None:
                        feats[ref] = turn_features(qinfo, tr, adm, idf, avg_turn_len)
                negs = [x for x in negatives if x in feats]
                poss = [x for x in pos_t if x in feats]
                denom = max(1, len(poss) * len(negs))
                for pt in poss:
                    for nt in negs:
                        tdiffs.append(feats[pt] - feats[nt])
                        ttypes.append(tid)
                        tweights.append(1.0 / denom)
                        tpids.append(pidx)
                stats['turn_cases'] += 1
                stats['turn_pairs'] += len(poss) * len(negs)
        print('training_pass', pidx + 1, '/', len(train_ids), pid, file=sys.stderr, flush=True)
    budgets = dict((key, percentile90(vals)) for key, vals in budget_values.items())
    arrays = {
        'admission': (np.asarray(adiffs, dtype=np.float32), np.asarray(atypes, dtype=np.int8),
                      np.asarray(aweights, dtype=np.float32), np.asarray(apids, dtype=np.int16)),
        'turn': (np.asarray(tdiffs, dtype=np.float32), np.asarray(ttypes, dtype=np.int8),
                 np.asarray(tweights, dtype=np.float32), np.asarray(tpids, dtype=np.int16)),
    }
    return arrays, budgets, stats


def empty_metric():
    return collections.defaultdict(float)


def add_rank_metric(metric, ranked_ids, positives, budget, ks, prefix=''):
    pset = set(positives)
    if not pset:
        return
    metric[prefix + 'cases'] += 1
    positions = [i + 1 for i, item in enumerate(ranked_ids) if item in pset]
    for k in ks:
        got = len(pset.intersection(ranked_ids[:k]))
        metric[prefix + 'recall@' + str(k)] += float(got) / len(pset)
        metric[prefix + 'any@' + str(k)] += float(got > 0)
        metric[prefix + 'all@' + str(k)] += float(got == len(pset))
    got = len(pset.intersection(ranked_ids[:budget]))
    metric[prefix + 'recall@budget'] += float(got) / len(pset)
    metric[prefix + 'all@budget'] += float(got == len(pset))
    metric[prefix + 'mrr'] += 1.0 / min(positions) if positions else 0.0
    pairs = 0
    wins = 0.0
    rank = dict((item, i) for i, item in enumerate(ranked_ids))
    for pos in pset:
        for neg in ranked_ids:
            if neg not in pset:
                pairs += 1
                if rank.get(pos, 10 ** 9) < rank[neg]:
                    wins += 1.0
    metric[prefix + 'pairwise_wins'] += wins
    metric[prefix + 'pairwise_pairs'] += pairs


def finalize_metric(metric):
    cases = metric.get('cases', 0.0)
    result = {'case_count': int(cases)}
    for key, value in sorted(metric.items()):
        if key in ('cases', 'pairwise_wins', 'pairwise_pairs'):
            continue
        result[key] = round(value / max(1.0, cases), 4)
    result['pairwise_accuracy'] = round(metric.get('pairwise_wins', 0.0) / max(1.0, metric.get('pairwise_pairs', 0.0)), 4)
    return result


def evaluate_admission(root, patient_ids, idf, avg_adm_len, avg_turn_len, budgets, model):
    groups = collections.defaultdict(empty_metric)
    baseline_groups = collections.defaultdict(empty_metric)
    cached_cases = []
    for pid in patient_ids:
        raw = load_json(os.path.join(root, 'patients', pid + '.json'))
        admissions, turn_by_ref = compact_patient(raw, idf, avg_adm_len, avg_turn_len)
        aids = list(admissions)
        for case in raw.get('cases', []):
            qtype = case.get('task', {}).get('question_type', '')
            if qtype not in TYPE_INDEX:
                continue
            qinfo = question_info(case.get('task', {}).get('question', ''))
            positives, _ = official(case)
            positives = [x for x in positives if x in admissions]
            if not positives:
                continue
            x = np.vstack([admission_features(qinfo, admissions[aid], idf, avg_adm_len, avg_turn_len) for aid in aids])
            tid = TYPE_INDEX[qtype]
            budget = case_budget(case, budgets, len(aids))
            learned_order = np.argsort(-model_scores(model, x, tid), kind='mergesort')
            base_order = np.argsort(-baseline_scores(x, 'admission'), kind='mergesort')
            learned = [aids[i] for i in learned_order]
            base = [aids[i] for i in base_order]
            keys = ['__all__', qtype, qtype + ':' + case.get('task', {}).get('scope', ''), 'patient:' + pid]
            for key in keys:
                add_rank_metric(groups[key], learned, positives, budget, (1, 2, 3, 5, 10))
                add_rank_metric(baseline_groups[key], base, positives, budget, (1, 2, 3, 5, 10))
            cached_cases.append({'pid': pid, 'type': qtype, 'x': x, 'aids': aids,
                                 'positives': positives, 'budget': budget})
        print('admission_eval', pid, file=sys.stderr, flush=True)
    return ({k: finalize_metric(v) for k, v in sorted(baseline_groups.items())},
            {k: finalize_metric(v) for k, v in sorted(groups.items())}, cached_cases)


def evaluate_turn(root, patient_ids, idf, avg_adm_len, avg_turn_len, admission_budgets,
                  admission_model, turn_model):
    base_groups = collections.defaultdict(empty_metric)
    learned_groups = collections.defaultdict(empty_metric)
    oracle_base_groups = collections.defaultdict(empty_metric)
    oracle_learned_groups = collections.defaultdict(empty_metric)
    for pid in patient_ids:
        raw = load_json(os.path.join(root, 'patients', pid + '.json'))
        admissions, turn_by_ref = compact_patient(raw, idf, avg_adm_len, avg_turn_len)
        aids = list(admissions)
        for case in raw.get('cases', []):
            qtype = case.get('task', {}).get('question_type', '')
            if qtype not in TYPE_INDEX:
                continue
            pos_a, pos_t = official(case)
            pos_a = [x for x in pos_a if x in admissions]
            pos_t = [x for x in pos_t if x in turn_by_ref]
            if not pos_t:
                continue
            tid = TYPE_INDEX[qtype]
            qinfo = question_info(case.get('task', {}).get('question', ''))
            ax = np.vstack([admission_features(qinfo, admissions[aid], idf, avg_adm_len, avg_turn_len) for aid in aids])
            budget = case_budget(case, admission_budgets, len(aids))
            learned_aids = [aids[i] for i in np.argsort(-model_scores(admission_model, ax, tid), kind='mergesort')[:budget]]
            base_aids = [aids[i] for i in np.argsort(-baseline_scores(ax, 'admission'), kind='mergesort')[:budget]]
            modes = (
                ('e2e_base', base_aids, base_groups, False),
                ('e2e_learned', learned_aids, learned_groups, True),
                ('oracle_base', pos_a, oracle_base_groups, False),
                ('oracle_learned', pos_a, oracle_learned_groups, True),
            )
            for _, selected_aids, target, use_learned in modes:
                refs = []
                feats = []
                for aid in selected_aids:
                    for tr in admissions[aid]['turns']:
                        refs.append(tr['ref'])
                        feats.append(turn_features(qinfo, tr, admissions[aid], idf, avg_turn_len))
                if not refs:
                    ranked = []
                else:
                    tx = np.vstack(feats)
                    score = model_scores(turn_model, tx, tid) if use_learned else baseline_scores(tx, 'turn')
                    ranked = [refs[i] for i in np.argsort(-score, kind='mergesort')]
                for key in ('__all__', qtype, 'patient:' + pid):
                    add_rank_metric(target[key], ranked, pos_t, 24, (1, 3, 5, 10, 24))
        print('turn_eval', pid, file=sys.stderr, flush=True)
    return {
        'end_to_end_baseline': {k: finalize_metric(v) for k, v in sorted(base_groups.items())},
        'end_to_end_pairwise': {k: finalize_metric(v) for k, v in sorted(learned_groups.items())},
        'oracle_admission_baseline': {k: finalize_metric(v) for k, v in sorted(oracle_base_groups.items())},
        'oracle_admission_pairwise': {k: finalize_metric(v) for k, v in sorted(oracle_learned_groups.items())},
    }


def inner_objective(cases, model):
    recalls = []
    allcov = []
    cross_recalls = []
    for row in cases:
        tid = TYPE_INDEX[row['type']]
        order = np.argsort(-model_scores(model, row['x'], tid), kind='mergesort')
        ranked = [row['aids'][i] for i in order]
        pos = set(row['positives'])
        got = len(pos.intersection(ranked[:row['budget']]))
        rec = float(got) / max(1, len(pos))
        recalls.append(rec)
        allcov.append(float(got == len(pos)))
        if row['budget'] > 1:
            cross_recalls.append(rec)
    return {'recall_budget': float(np.mean(recalls)), 'all_budget': float(np.mean(allcov)),
            'cross_recall_budget': float(np.mean(cross_recalls)) if cross_recalls else 0.0,
            'objective': 0.25 * float(np.mean(recalls)) + 0.75 * (float(np.mean(cross_recalls)) if cross_recalls else 0.0)}


def serial_model(model, feature_names):
    raw_global = model['global'] / model['scale']
    raw_type = model['type'] / model['scale'][None, :]
    by_type = {}
    for tid, name in enumerate(TYPES):
        effective = raw_global + raw_type[tid]
        rows = sorted(zip(feature_names, effective.tolist()), key=lambda x: -abs(x[1]))
        by_type[name] = [{'feature': key, 'coefficient': round(value, 6)} for key, value in rows]
    return {
        'global_l2': model['global_l2'], 'type_l2': model['type_l2'],
        'steps': model['steps'], 'learning_rate': model['learning_rate'],
        'feature_scale': dict((feature_names[i], round(float(model['scale'][i]), 6)) for i in range(len(feature_names))),
        'raw_global_coefficients': dict((feature_names[i], round(float(raw_global[i]), 6)) for i in range(len(feature_names))),
        'effective_coefficients_by_type': by_type,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='data/medlocomo-full-distillation')
    parser.add_argument('--output', default='/private/tmp/medlocomo_pairwise_report.json')
    args = parser.parse_args()
    start = time.time()
    root = os.path.abspath(args.root)
    manifest = load_json(os.path.join(root, 'manifest.json'))
    all_ids = sorted(str(x['patient_id']) for x in manifest['shards'])
    holdout_ids = list(HOLDOUT)
    train_ids = [x for x in all_ids if x not in HOLDOUT]
    assert len(train_ids) == 97 and len(holdout_ids) == 4
    inner_ids = [x for x in train_ids if deterministic_inner_dev(x)]
    print('split train', len(train_ids), 'holdout', holdout_ids, 'inner_dev', inner_ids, file=sys.stderr, flush=True)
    idf, avg_adm_len, avg_turn_len, ndocs = build_idf(root, train_ids)
    arrays, budgets, stats = make_training_data(root, train_ids, idf, avg_adm_len, avg_turn_len)
    ad, at, aw, ap = arrays['admission']
    td, tt, tw, tp = arrays['turn']
    inner_indices = set(train_ids.index(x) for x in inner_ids)
    admission_fitmask = np.asarray([int(x) not in inner_indices for x in ap], dtype=bool)
    turn_fitmask = np.asarray([int(x) not in inner_indices for x in tp], dtype=bool)
    # Build inner-dev feature cache once. This never touches the fixed 4-patient validation.
    _, _, inner_cases = evaluate_admission(root, inner_ids, idf, avg_adm_len, avg_turn_len, budgets,
                                            pairwise_fit(ad, at, aw, admission_fitmask, type_l2=0.15, steps=80))
    candidates = []
    for type_l2 in (0.04, 0.10, 0.20, 0.40):
        model = pairwise_fit(ad, at, aw, admission_fitmask, global_l2=0.02,
                             type_l2=type_l2, steps=120, learning_rate=0.04)
        score = inner_objective(inner_cases, model)
        candidates.append((score['objective'], type_l2, score))
        print('inner_candidate', type_l2, score, file=sys.stderr, flush=True)
    candidates.sort(reverse=True)
    selected_type_l2 = candidates[0][1]
    admission_model = pairwise_fit(ad, at, aw, None, global_l2=0.02,
                                   type_l2=selected_type_l2, steps=150, learning_rate=0.04)
    # Turn regularization is fixed from the inner training corpus to avoid another holdout-facing choice.
    turn_model = pairwise_fit(td, tt, tw, None, global_l2=0.025,
                              type_l2=0.16, steps=150, learning_rate=0.04)
    baseline_adm, learned_adm, _ = evaluate_admission(root, holdout_ids, idf, avg_adm_len,
                                                       avg_turn_len, budgets, admission_model)
    turn_metrics = evaluate_turn(root, holdout_ids, idf, avg_adm_len, avg_turn_len, budgets,
                                 admission_model, turn_model)
    report = {
        'prototype': 'medlocomo_pairwise_rankers.v1',
        'runtime_eligible': False,
        'scope': 'offline_prototype_only',
        'split': {
            'method': 'patient_disjoint', 'train_patient_count': len(train_ids),
            'validation_patient_count': len(holdout_ids), 'validation_patient_ids': holdout_ids,
            'inner_dev_patient_count': len(inner_ids),
            'inner_dev_commitment': hashlib.sha256(('\n'.join(sorted(inner_ids))).encode('utf8')).hexdigest(),
        },
        'data_boundary': {
            'runtime_features': ['question_text', 'question_type', 'scope', 'admission_dates_and_order', 'source_turn_text_and_speaker'],
            'positive_training_labels': ['official_evidence.admission_ids', 'official_evidence.turn_refs'],
            'negative_mining_only': ['same-patient teacher hard-negative source refs', 'same-patient lexical top negatives'],
            'not_used_as_features': ['gold_answer', 'required_concepts', 'gold-derived expansion terms', 'teacher-selected positive turns', 'qa_id', 'patient_id lookup'],
        },
        'corpus': {'train_admission_documents': ndocs, 'avg_admission_content_tokens': round(avg_adm_len, 3),
                   'avg_turn_content_tokens': round(avg_turn_len, 3)},
        'training': dict(stats),
        'admission_budget_by_type_operation': dict((key[0] + ':' + key[1], value) for key, value in sorted(budgets.items())),
        'selection': {'admission_type_l2': selected_type_l2,
                      'inner_candidates': [{'type_l2': x[1], **dict((k, round(v, 6)) for k, v in x[2].items())} for x in candidates]},
        'admission_router': {
            'feature_names': list(ADMISSION_FEATURES),
            'model': serial_model(admission_model, ADMISSION_FEATURES),
            'validation': {'lexical_baseline': baseline_adm, 'pairwise': learned_adm},
        },
        'turn_ranker': {
            'feature_names': list(TURN_FEATURES),
            'model': serial_model(turn_model, TURN_FEATURES),
            'validation': turn_metrics,
        },
        'elapsed_seconds': round(time.time() - start, 3),
    }
    with open(args.output, 'w') as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write('\n')
    print(json.dumps({'output': args.output, 'elapsed_seconds': report['elapsed_seconds'],
                      'admission_baseline_all': baseline_adm.get('__all__'),
                      'admission_pairwise_all': learned_adm.get('__all__'),
                      'turn_pairwise_all': turn_metrics['end_to_end_pairwise'].get('__all__')}, indent=2), flush=True)


if __name__ == '__main__':
    main()
