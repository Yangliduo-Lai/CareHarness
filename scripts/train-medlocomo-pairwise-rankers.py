#!/usr/bin/env python3
"""Train patient-disjoint MedLoCoMo Admission and Turn pairwise rankers.

The validation protocol is fixed by default to four patients. Hyperparameters are
selected inside the remaining 97-patient set, and the serialized default model is
the same 97-patient model evaluated on those fixed four. ``--refit-all`` is an
explicit transductive mode that instead emits a separately named all-101 model;
that artifact is not valid evidence for a held-out claim.

Dependencies: NumPy and sentence-transformers. By default the embedding model
must already exist in the local Hugging Face cache; no API or network is used.
"""
from __future__ import print_function

import argparse
import collections
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import unicodedata

import numpy as np


VERSION = 'medlocomo-pairwise-rankers.v3-runtime-feature-aligned-with-lexical-fallback'
EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
EMBEDDING_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9'
EMBEDDING_BASE_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
EMBEDDING_BASE_MODEL_REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41'
EMBEDDING_DIMENSION = 384
EMBEDDING_CHUNK_TURNS = 6
EMBEDDING_SNAPSHOT_HASH = '52969911136eb2bdc5a922ec66ee0f5e633c5d8f3281cfbe0174387fbf2af2d3'
EMBEDDING_SNAPSHOT_FILE_HASHES = {
    'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
    'onnx/model.onnx': '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
    'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
}
DEFAULT_HOLDOUT = ('10913302', '11021643', '11441519', '11826927')
DEFAULT_PATIENT_DISJOINT_OUTPUT = (
    'data/medlocomo-hierarchical-distillation/'
    'pairwise-rankers-97train-4validation.json'
)
DEFAULT_TRANSDUCTIVE_OUTPUT = (
    'data/medlocomo-hierarchical-distillation/'
    'pairwise-rankers-all101-transductive.json'
)
QUESTION_TYPES = (
    'adversarial', 'care_plan_rationale', 'cross_admission_comparison',
    'frequency_pattern', 'longitudinal_progression', 'medical_reasoning',
)
ADMISSION_ORIGINAL_RESIDUAL = (3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16)
ADMISSION_DENSE_NAMES = (
    'dense_chunk_max_cosine', 'dense_chunk_top2_cosine',
    'dense_admission_centroid_cosine',
)
TURN_RESIDUAL = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13)
ADMISSION_L2 = (0.03, 0.10, 0.30, 1.0, 3.0)
TURN_L2 = (0.03, 0.10, 0.30, 1.0, 3.0)
GAINS = (0.0, 0.05, 0.10, 0.20, 0.35, 0.50, 0.75, 1.0, 1.5, 2.0)


def load_library():
    path = Path(__file__).resolve().parent / 'lib' / 'medlocomo_pairwise_training.py'
    spec = importlib.util.spec_from_file_location('medlocomo_pairwise_training', str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load_library()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--teacher-root', default='data/medlocomo-full-distillation')
    parser.add_argument('--output', default=None,
                        help='Output path; defaults to a split-specific, non-overlapping name')
    parser.add_argument('--holdout-patients', default=','.join(DEFAULT_HOLDOUT))
    parser.add_argument('--embedding-model', default=None,
                        help='Local SentenceTransformer directory; defaults to the cached all-MiniLM-L6-v2 revision')
    parser.add_argument('--allow-model-download', action='store_true', default=False)
    parser.add_argument('--chunk-turns', type=int, default=EMBEDDING_CHUNK_TURNS,
                        help='Compatibility flag; the runtime contract requires exactly 6')
    parser.add_argument('--refit-all', dest='refit_all', action='store_true', default=False,
                        help='Explicitly emit a transductive all-101 model after fixed validation')
    parser.add_argument('--no-refit-all', dest='refit_all', action='store_false')
    return parser.parse_args()


def embedding_model_path(explicit, allow_download):
    if explicit:
        if explicit == EMBEDDING_BASE_MODEL:
            if not allow_download:
                raise ValueError(
                    '--embedding-model as a Hub id requires --allow-model-download'
                )
            return explicit
        candidate = Path(explicit).resolve()
        if (not candidate.exists() or candidate.parent.name != 'snapshots'
                or candidate.name != EMBEDDING_BASE_MODEL_REVISION):
            raise ValueError(
                '--embedding-model must be the pinned all-MiniLM-L6-v2 snapshot '
                + EMBEDDING_BASE_MODEL_REVISION
            )
        return str(candidate)
    root = Path(__file__).resolve().parents[1]
    cache = root / '.cache' / 'sentence-transformers' / 'models--sentence-transformers--all-MiniLM-L6-v2'
    candidate = cache / 'snapshots' / EMBEDDING_BASE_MODEL_REVISION
    if candidate.exists():
        return str(candidate)
    if allow_download:
        return EMBEDDING_BASE_MODEL
    raise RuntimeError(
        'Pinned local all-MiniLM-L6-v2 snapshot is missing: '
        + EMBEDDING_BASE_MODEL_REVISION
    )


def load_embedding_model(path, allow_download):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as error:
        raise RuntimeError('sentence-transformers is required; run this script in the local baseline venv') from error
    return SentenceTransformer(
        path,
        revision=EMBEDDING_BASE_MODEL_REVISION if path == EMBEDDING_BASE_MODEL else None,
        local_files_only=not allow_download,
    )


def read_json(path):
    with open(path, 'r') as handle:
        return json.load(handle)


def artifact_hash(value):
    body = dict(value)
    body.pop('artifact_hash', None)
    return hashlib.sha256(stable_json(body).encode('utf8')).hexdigest()


def validate_teacher_corpus(root, manifest):
    """Fail closed unless every declared Teacher shard is intact and complete."""
    if (manifest.get('version') != 'medlocomo-full-teacher-manifest.v1'
            or manifest.get('benchmark') != 'medlocomo'
            or manifest.get('runtime_eligible') is not False
            or manifest.get('artifact_hash') != artifact_hash(manifest)):
        raise ValueError('MedLoCoMo Teacher manifest is invalid or has a hash mismatch')
    root_path = Path(root).resolve()
    patient_ids, shard_paths, qa_ids = set(), set(), set()
    totals = collections.Counter()
    shards = manifest.get('shards', [])
    for declaration in shards:
        patient_id = str(declaration.get('patient_id', ''))
        relative_path = str(declaration.get('path', ''))
        shard_path = (root_path / relative_path).resolve()
        if (not patient_id or patient_id in patient_ids or not relative_path
                or relative_path in shard_paths or not shard_path.is_relative_to(root_path)):
            raise ValueError('MedLoCoMo Teacher manifest has a duplicate or unsafe shard')
        raw = read_json(shard_path)
        if (raw.get('benchmark') != 'medlocomo'
                or str(raw.get('patient_id', '')) != patient_id
                or raw.get('artifact_hash') != declaration.get('artifact_hash')
                or raw.get('artifact_hash') != artifact_hash(raw)):
            raise ValueError('MedLoCoMo Teacher shard identity or hash mismatch: ' + patient_id)
        counts = {
            'admission_count': len(raw.get('admissions', [])),
            'source_turn_count': len(raw.get('source_turns', [])),
            'case_count': len(raw.get('cases', [])),
        }
        if (any(int(declaration.get(key, -1)) != value for key, value in counts.items())
                or any(int(raw.get('stats', {}).get(key, -1)) != value
                       for key, value in counts.items())):
            raise ValueError('MedLoCoMo Teacher shard counts do not match: ' + patient_id)
        for case in raw.get('cases', []):
            qa_id = str(case.get('qa_id', ''))
            if not qa_id or qa_id in qa_ids:
                raise ValueError('MedLoCoMo Teacher corpus has a missing or duplicate qa_id')
            qa_ids.add(qa_id)
        patient_ids.add(patient_id)
        shard_paths.add(relative_path)
        totals.update(counts)
    selection = manifest.get('selection', {})
    expected = {
        'patient_count': len(shards),
        'admission_count': totals['admission_count'],
        'source_turn_count': totals['source_turn_count'],
        'question_count': totals['case_count'],
    }
    if any(int(selection.get(key, -1)) != value for key, value in expected.items()):
        raise ValueError('MedLoCoMo Teacher manifest totals do not match its shards')
    invalid = manifest.get('source_validation', {})
    if any(int(value) != 0 for value in invalid.values()):
        raise ValueError('MedLoCoMo Teacher manifest reports invalid source references')


def commitment(values):
    return hashlib.sha256('\n'.join(sorted(set(str(x) for x in values))).encode('utf8')).hexdigest()


def current_patient_statistics(raw):
    """Mirror runtime localIdf: one document per visible Admission of this patient."""
    admission_tokens = collections.defaultdict(list)
    admission_has_turn = set()
    turn_lengths = []
    for turn in raw.get('source_turns', []):
        admission_id = str(turn.get('admission_id', ''))
        sequence = P.content_tokens(turn.get('text', ''))
        admission_has_turn.add(admission_id)
        admission_tokens[admission_id].extend(sequence)
        turn_lengths.append(len(sequence))
    ordered_ids = []
    for row in sorted(raw.get('admissions', []),
                      key=lambda value: int(value.get('admission_order', 0) or 0)):
        admission_id = str(row.get('admission_id', ''))
        if admission_id in admission_has_turn and admission_id not in ordered_ids:
            ordered_ids.append(admission_id)
    for admission_id in admission_has_turn:
        if admission_id not in ordered_ids:
            ordered_ids.append(admission_id)
    lengths = [len(admission_tokens[admission_id]) for admission_id in ordered_ids]
    document_count = max(1, len(ordered_ids))
    document_frequency = collections.Counter()
    for admission_id in ordered_ids:
        document_frequency.update(set(admission_tokens[admission_id]))
    idf = dict((term, math.log(1.0 +
                               (document_count - frequency + 0.5) /
                               (frequency + 0.5)))
               for term, frequency in document_frequency.items())
    idf['__default__'] = math.log(1.0 + (document_count + 0.5) / 0.5)
    average_admission_length = float(sum(lengths)) / max(1, len(lengths))
    average_turn_length = float(sum(turn_lengths)) / max(1, len(turn_lengths))
    return idf, average_admission_length, average_turn_length


def runtime_aligned_patient(raw):
    """Normalize and order source Turns exactly as the JS runtime does."""
    aligned = dict(raw)
    aligned['source_turns'] = []
    for source_order, turn in enumerate(raw.get('source_turns', [])):
        value = dict(turn)
        value['text'] = unicodedata.normalize('NFKC', str(turn.get('text', ''))).strip()
        value['_source_order'] = source_order
        aligned['source_turns'].append(value)
    aligned['source_turns'].sort(key=lambda turn: (
        str(turn.get('admission_id', '')),
        int(turn.get('turn_number', 0) or 0),
        str(turn.get('time', '')),
        int(turn.get('_source_order', 0)),
    ))
    return aligned


def align_compact_patient_to_runtime(admissions, source_order_by_ref):
    """Runtime derives Admission dates from its first/last visible source Turn."""
    for admission in admissions.values():
        admission['turns'].sort(key=lambda turn: (
            int(turn.get('number', 0) or 0), str(turn.get('time', '')),
            int(source_order_by_ref.get(str(turn.get('ref', '')), 0)),
        ))
        dates = [P.parse_date(turn.get('time', '')) for turn in admission['turns']]
        dates = [value for value in dates if value is not None]
        admission['start'] = min(dates) if dates else None
        admission['end'] = max(dates) if dates else None


def dense_admission_features(model, admissions, cases, chunk_turns):
    aids = list(admissions)
    chunks, spans = [], []
    for aid in aids:
        start = len(chunks)
        turns = admissions[aid]['turns']
        for offset in range(0, len(turns), chunk_turns):
            rows = turns[offset:offset + chunk_turns]
            chunks.append(' '.join(
                ('doctor: ' if ('doctor' in row['speaker'] or 'clinician' in row['speaker']) else 'patient: ')
                + ' '.join(row['seq']) for row in rows
            ))
        if len(chunks) == start:
            chunks.append('empty admission')
        spans.append((start, len(chunks)))
    chunk_vectors = model.encode(chunks, batch_size=96, show_progress_bar=False,
                                 normalize_embeddings=True, convert_to_numpy=True)
    questions = [unicodedata.normalize('NFKC', str(case['task']['question'])).strip()[:1600]
                 for case in cases]
    question_vectors = model.encode(questions, batch_size=96,
                                    show_progress_bar=False, normalize_embeddings=True,
                                    convert_to_numpy=True)
    similarities = np.dot(question_vectors, chunk_vectors.T)
    centroids = []
    for low, high in spans:
        centroid = chunk_vectors[low:high].mean(axis=0)
        centroid = centroid / max(1e-9, float(np.linalg.norm(centroid)))
        centroids.append(centroid)
    centroid_scores = np.dot(question_vectors, np.asarray(centroids).T)
    output = []
    for qindex in range(len(cases)):
        rows = []
        for aindex, (low, high) in enumerate(spans):
            values = np.sort(similarities[qindex, low:high])[::-1]
            rows.append((float(values[0]), float(values[:2].mean()),
                         float(centroid_scores[qindex, aindex])))
        output.append(np.asarray(rows, dtype=np.float32))
    return aids, output, int(len(chunks)), int(chunk_vectors.shape[1])


def append_admission_pairs(case, qinfo, admissions, by_ref, aids, dense, idf,
                           avg_admission_length, avg_turn_length, patient_index,
                           differences, type_ids, pair_weights, patient_indices):
    qtype = case['task']['question_type']
    positives, _ = P.official(case)
    positives = [value for value in positives if value in admissions]
    if not positives:
        return 0
    positive_set = set(positives)
    quick = []
    for aid in aids:
        if aid not in positive_set:
            quick.append((P.bm25(qinfo['terms'], admissions[aid], idf, avg_admission_length), aid))
    quick.sort(reverse=True)
    teacher = []
    for ref in P.hard_negative_refs(case):
        turn = by_ref.get(ref)
        if turn and turn['admission_id'] not in positive_set and turn['admission_id'] not in teacher:
            teacher.append(turn['admission_id'])
    negatives = teacher[:5]
    for _, aid in quick:
        if aid not in negatives:
            negatives.append(aid)
        if len(negatives) >= 10:
            break
    aid_index = dict((value, index) for index, value in enumerate(aids))
    selected = list(dict.fromkeys(positives + negatives))
    features = {}
    for aid in selected:
        lexical = P.admission_features(qinfo, admissions[aid], idf,
                                       avg_admission_length, avg_turn_length)
        features[aid] = np.concatenate([lexical, dense[aid_index[aid]]])
    denominator = max(1, len(positives) * len(negatives))
    for positive in positives:
        for negative in negatives:
            differences.append(features[positive] - features[negative])
            type_ids.append(P.TYPE_INDEX[qtype])
            pair_weights.append(1.0 / denominator)
            patient_indices.append(patient_index)
    return len(positives) * len(negatives)


def append_turn_pairs(case, qinfo, admissions, by_ref, idf, avg_turn_length,
                      patient_index, differences, type_ids, pair_weights,
                      patient_indices):
    qtype = case['task']['question_type']
    positive_admissions, positives = P.official(case)
    positive_admissions = [value for value in positive_admissions if value in admissions]
    positives = [value for value in positives if value in by_ref]
    if not positives:
        return 0
    positive_set = set(positives)
    candidates = []
    for aid in positive_admissions:
        candidates.extend(turn['ref'] for turn in admissions[aid]['turns'])
    teacher = [value for value in P.hard_negative_refs(case)
               if value in by_ref and value not in positive_set]
    quick = []
    for ref in candidates:
        if ref not in positive_set:
            quick.append((P.bm25(qinfo['terms'], by_ref[ref], idf, avg_turn_length), ref))
    quick.sort(reverse=True)
    negatives = teacher[:5]
    for _, ref in quick:
        if ref not in negatives:
            negatives.append(ref)
        if len(negatives) >= 14:
            break
    selected = list(dict.fromkeys(positives + negatives))
    features = {}
    for ref in selected:
        turn = by_ref[ref]
        admission = admissions.get(turn['admission_id'])
        if admission is not None:
            features[ref] = P.turn_features(qinfo, turn, admission, idf, avg_turn_length)
    valid_positives = [value for value in positives if value in features]
    valid_negatives = [value for value in negatives if value in features]
    denominator = max(1, len(valid_positives) * len(valid_negatives))
    for positive in valid_positives:
        for negative in valid_negatives:
            differences.append(features[positive] - features[negative])
            type_ids.append(P.TYPE_INDEX[qtype])
            pair_weights.append(1.0 / denominator)
            patient_indices.append(patient_index)
    return len(valid_positives) * len(valid_negatives)


def evaluation_rows(cases, admissions, aids, dense_rows, idf, avg_admission_length,
                    avg_turn_length, budgets):
    admission_rows, turn_rows = [], []
    for index, case in enumerate(cases):
        qtype = case['task']['question_type']
        qinfo = P.question_info(case['task']['question'])
        positive_admissions, positive_turns = P.official(case)
        positive_admissions = [value for value in positive_admissions if value in admissions]
        positive_turns = [value for value in positive_turns
                          if any(value == turn['ref'] for aid in positive_admissions
                                 for turn in admissions[aid]['turns'])]
        if positive_admissions:
            lexical = np.vstack([P.admission_features(qinfo, admissions[aid], idf,
                                                      avg_admission_length, avg_turn_length)
                                 for aid in aids])
            admission_rows.append({
                'type': qtype, 'ids': aids, 'positives': positive_admissions,
                'budget': P.case_budget(case, budgets, len(aids)),
                'features': np.hstack([lexical, dense_rows[index]]),
            })
        if positive_turns:
            refs, features = [], []
            for aid in positive_admissions:
                for turn in admissions[aid]['turns']:
                    refs.append(turn['ref'])
                    features.append(P.turn_features(qinfo, turn, admissions[aid],
                                                    idf, avg_turn_length))
            turn_rows.append({
                'type': qtype, 'ids': refs, 'positives': positive_turns,
                'budget': 24, 'features': np.vstack(features),
            })
    return admission_rows, turn_rows


def collect(root, patient_ids, train_ids, holdout_ids, inner_ids, model,
            chunk_turns, budgets):
    admission_differences, admission_types, admission_weights, admission_patients = [], [], [], []
    turn_differences, turn_types, turn_weights, turn_patients = [], [], [], []
    inner_admissions, inner_turns, validation_admissions, validation_turns = [], [], [], []
    chunk_count = 0
    embedding_dimension = 0
    train_set, holdout_set, inner_set = set(train_ids), set(holdout_ids), set(inner_ids)
    patient_index = dict((value, index) for index, value in enumerate(patient_ids))
    stats = collections.Counter()
    for ordinal, pid in enumerate(patient_ids):
        raw = runtime_aligned_patient(read_json(os.path.join(root, 'patients', pid + '.json')))
        idf, avg_admission_length, avg_turn_length = current_patient_statistics(raw)
        admissions, by_ref = P.compact_patient(raw, idf, avg_admission_length, avg_turn_length)
        align_compact_patient_to_runtime(admissions, {
            str(turn.get('source_ref', '')): int(turn.get('_source_order', 0))
            for turn in raw.get('source_turns', [])
        })
        cases = raw['cases']
        aids, dense_rows, chunks, dimension = dense_admission_features(model, admissions, cases,
                                                                       chunk_turns)
        chunk_count += chunks
        embedding_dimension = dimension
        for case_index, case in enumerate(cases):
            qinfo = P.question_info(case['task']['question'])
            stats['admission_pairs'] += append_admission_pairs(
                case, qinfo, admissions, by_ref, aids, dense_rows[case_index], idf,
                avg_admission_length, avg_turn_length, patient_index[pid],
                admission_differences, admission_types, admission_weights,
                admission_patients,
            )
            stats['turn_pairs'] += append_turn_pairs(
                case, qinfo, admissions, by_ref, idf, avg_turn_length,
                patient_index[pid], turn_differences, turn_types, turn_weights,
                turn_patients,
            )
        if pid in inner_set or pid in holdout_set:
            admission_rows, turn_rows = evaluation_rows(
                cases, admissions, aids, dense_rows, idf, avg_admission_length,
                avg_turn_length, budgets,
            )
            if pid in inner_set:
                inner_admissions.extend(admission_rows);inner_turns.extend(turn_rows)
            if pid in holdout_set:
                validation_admissions.extend(admission_rows);validation_turns.extend(turn_rows)
        print('feature_pass %d/%d %s' % (ordinal + 1, len(patient_ids),
                                        'validation' if pid in holdout_set else 'train'),
              file=sys.stderr, flush=True)
    arrays = {
        'admission': (
            np.asarray(admission_differences, dtype=np.float32),
            np.asarray(admission_types, dtype=np.int8),
            np.asarray(admission_weights, dtype=np.float32),
            np.asarray(admission_patients, dtype=np.int16),
        ),
        'turn': (
            np.asarray(turn_differences, dtype=np.float32),
            np.asarray(turn_types, dtype=np.int8),
            np.asarray(turn_weights, dtype=np.float32),
            np.asarray(turn_patients, dtype=np.int16),
        ),
    }
    rows = {
        'inner_admission': inner_admissions, 'inner_turn': inner_turns,
        'validation_admission': validation_admissions,
        'validation_turn': validation_turns,
    }
    return arrays, rows, dict(stats), chunk_count, embedding_dimension


def anchored_fit(differences, type_ids, pair_weights, mask, anchor_vector,
                 residual_indices, l2, steps=180, learning_rate=0.04):
    differences = differences[mask]
    type_ids = type_ids[mask]
    pair_weights = pair_weights[mask]
    anchor_difference = np.dot(differences, anchor_vector)
    residual_difference = differences[:, residual_indices]
    anchor_scale = float(np.sqrt(np.average(anchor_difference * anchor_difference,
                                             weights=pair_weights)))
    residual_scale = np.sqrt(np.average(residual_difference * residual_difference,
                                        axis=0, weights=pair_weights)).astype(float)
    residual_scale[residual_scale < 1e-5] = 1.0
    anchor_z = anchor_difference / max(1e-9, anchor_scale)
    residual_z = residual_difference / residual_scale
    learned = np.zeros((len(QUESTION_TYPES), len(residual_indices)), dtype=float)
    for type_id in range(len(QUESTION_TYPES)):
        selected = type_ids == type_id
        if not np.any(selected):
            continue
        x = residual_z[selected]
        base = anchor_z[selected]
        weights = pair_weights[selected]
        coefficient = np.zeros(len(residual_indices), dtype=float)
        first = np.zeros_like(coefficient)
        second = np.zeros_like(coefficient)
        denominator = float(weights.sum())
        for step in range(steps):
            margin = base + np.dot(x, coefficient)
            probability = 1.0 / (1.0 + np.exp(np.clip(margin, -35, 35)))
            gradient = (-np.sum(x * (probability * weights)[:, None], axis=0)
                        / denominator + l2 * coefficient)
            first = 0.9 * first + 0.1 * gradient
            second = 0.999 * second + 0.001 * gradient * gradient
            coefficient -= learning_rate * (first / (1 - 0.9 ** (step + 1))) / (
                np.sqrt(second / (1 - 0.999 ** (step + 1))) + 1e-8)
            coefficient = np.maximum(coefficient, 0.0)
        learned[type_id] = coefficient
    return {
        'anchor_scale': anchor_scale, 'residual_scale': residual_scale,
        'weights': learned, 'l2': l2,
    }


def model_score(model, features, qtype, gain, anchor_vector, residual_indices):
    anchor = np.dot(features, anchor_vector) / model['anchor_scale']
    residual = np.dot(features[:, residual_indices] / model['residual_scale'],
                      model['weights'][P.TYPE_INDEX[qtype]])
    return anchor + gain * residual


def rank_metrics(rows, model_by_l2, choices, anchor_vector, residual_indices,
                 ks, force_gain=None):
    groups = collections.defaultdict(lambda: collections.defaultdict(float))
    for row in rows:
        choice = choices[row['type']]
        model = model_by_l2[choice['l2']]
        gain = choice['gain'] if force_gain is None else force_gain
        scores = model_score(model, row['features'], row['type'], gain,
                             anchor_vector, residual_indices)
        ranked = [row['ids'][index] for index in np.argsort(-scores, kind='mergesort')]
        positives = set(row['positives'])
        for key in ('__all__', row['type']):
            metric = groups[key]
            metric['case_count'] += 1
            for k in ks:
                count = len(positives.intersection(ranked[:k]))
                metric['recall@%d' % k] += float(count) / len(positives)
                metric['any@%d' % k] += float(count > 0)
                metric['all@%d' % k] += float(count == len(positives))
            count = len(positives.intersection(ranked[:row['budget']]))
            metric['recall@budget'] += float(count) / len(positives)
            metric['all@budget'] += float(count == len(positives))
            positions = [index + 1 for index, value in enumerate(ranked)
                         if value in positives]
            metric['mrr'] += 1.0 / min(positions) if positions else 0.0
    output = {}
    for key, metric in sorted(groups.items()):
        count = metric.pop('case_count')
        output[key] = {'case_count': int(count)}
        output[key].update((name, rounded(value / count, 4))
                           for name, value in sorted(metric.items()))
    return output


def objective(metric, kind):
    if kind == 'admission':
        return 0.8 * metric['recall@budget'] + 0.2 * metric['all@budget']
    return 0.75 * metric['recall@24'] + 0.15 * metric['recall@5'] + 0.10 * metric['mrr']


def select_hyperparameters(kind, arrays, rows, fit_mask, anchor_vector,
                           residual_indices, l2_values, ks):
    differences, type_ids, pair_weights, _ = arrays
    choices = {}
    for l2 in l2_values:
        model = anchored_fit(differences, type_ids, pair_weights, fit_mask,
                             anchor_vector, residual_indices, l2)
        for qtype in QUESTION_TYPES:
            subset = [row for row in rows if row['type'] == qtype]
            if not subset:
                continue
            for gain in GAINS:
                temporary = {qtype: {'l2': l2, 'gain': gain}}
                metrics = rank_metrics(subset, {l2: model}, temporary,
                                       anchor_vector, residual_indices, ks)
                candidate = {
                    'l2': l2, 'gain': gain,
                    'objective': objective(metrics['__all__'], kind),
                    'metrics': metrics['__all__'],
                }
                prior = choices.get(qtype)
                if prior is None or (-candidate['objective'], gain, l2) < (
                        -prior['objective'], prior['gain'], prior['l2']):
                    choices[qtype] = candidate
    for qtype in QUESTION_TYPES:
        choices.setdefault(qtype, {'l2': l2_values[0], 'gain': 0.0,
                                   'objective': 0.0, 'metrics': {'case_count': 0}})
    return choices


def fit_dispatch_models(arrays, mask, choices, anchor_vector, residual_indices):
    differences, type_ids, pair_weights, _ = arrays
    return dict((l2, anchored_fit(differences, type_ids, pair_weights, mask,
                                  anchor_vector, residual_indices, l2))
                for l2 in sorted(set(choice['l2'] for choice in choices.values())))


def serialize_ranker(kind, models, choices, anchor_vector, residual_indices,
                     feature_names, pair_count, required_dense_features):
    representative = next(iter(models.values()))
    anchor_coefficients = {}
    for index, coefficient in enumerate(anchor_vector):
        if coefficient:
            anchor_coefficients[feature_names[index]] = rounded(
                coefficient / representative['anchor_scale'], 6)
    parameters = {}
    for qtype in QUESTION_TYPES:
        choice = choices[qtype]
        model = models[choice['l2']]
        type_id = P.TYPE_INDEX[qtype]
        residual = {}
        for local_index, feature_index in enumerate(residual_indices):
            value = (choice['gain'] * model['weights'][type_id, local_index]
                     / model['residual_scale'][local_index])
            residual[feature_names[feature_index]] = rounded(value, 6)
        parameters[qtype] = {
            'l2': rounded(choice['l2'], 6),
            'residual_gain': rounded(choice['gain'], 6),
            'residual_coefficients': residual,
        }
    return {
        'kind': ('fixed_lexical_anchor_plus_nonnegative_pairwise_dense_residual'
                 if kind == 'admission'
                 else 'fixed_lexical_anchor_plus_nonnegative_pairwise_residual'),
        'training_pair_count': int(pair_count),
        'anchor_coefficients': anchor_coefficients,
        'required_dense_features': list(required_dense_features),
        'parameters_by_question_type': parameters,
    }


def rounded(value, digits=6):
    number = round(float(value), digits)
    if number == 0:
        return 0
    if number.is_integer():
        return int(number)
    return number


def js_number(value):
    if not math.isfinite(value):
        raise ValueError('Non-finite number cannot be serialized')
    if value == 0:
        return '0'
    if value.is_integer():
        return str(int(value))
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        # Python and JavaScript both use shortest-round-trip decimal output for
        # ordinary JSON numbers.  Keep Python's shortest form when it is not
        # exponential; fixed precision can expose binary tails (for example,
        # 9.056104 -> 9.056103999999999) and break the JS artifact verifier.
        shortest = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        if 'e' not in shortest.lower():
            return shortest
        return format(value, '.15f').rstrip('0').rstrip('.')
    mantissa, exponent = format(value, '.15e').split('e')
    mantissa = mantissa.rstrip('0').rstrip('.')
    exponent = str(int(exponent))
    return mantissa + 'e' + ('+' if int(exponent) >= 0 else '') + exponent


def stable_json(value):
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(str(key), ensure_ascii=False) + ':'
                              + stable_json(value[key]) for key in sorted(value)) + '}'
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(stable_json(item) for item in value) + ']'
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, (float, np.floating)):
        return js_number(float(value))
    raise TypeError('Unsupported stable JSON value %r' % type(value))


def main():
    args = parse_args()
    if args.chunk_turns != EMBEDDING_CHUNK_TURNS:
        raise ValueError('--chunk-turns must be 6 to match the runtime feature contract')
    root = os.path.abspath(args.teacher_root)
    manifest = read_json(os.path.join(root, 'manifest.json'))
    validate_teacher_corpus(root, manifest)
    patient_ids = sorted(str(row['patient_id']) for row in manifest['shards'])
    holdout_ids = [value.strip() for value in args.holdout_patients.split(',')
                   if value.strip()]
    unknown = sorted(set(holdout_ids).difference(patient_ids))
    if unknown or not holdout_ids or len(holdout_ids) >= len(patient_ids):
        raise ValueError('Invalid fixed validation split')
    train_ids = [value for value in patient_ids if value not in set(holdout_ids)]
    inner_ids = [value for value in train_ids if P.deterministic_inner_dev(value)]
    patient_disjoint_output = os.path.abspath(DEFAULT_PATIENT_DISJOINT_OUTPUT)
    transductive_output = os.path.abspath(DEFAULT_TRANSDUCTIVE_OUTPUT)
    fixed_holdout = sorted(holdout_ids) == sorted(DEFAULT_HOLDOUT)
    if args.output is None:
        if not args.refit_all and not fixed_holdout:
            raise ValueError('A custom validation split requires an explicit --output path')
        output = transductive_output if args.refit_all else patient_disjoint_output
    else:
        output = os.path.abspath(args.output)
    if output == patient_disjoint_output and (args.refit_all or not fixed_holdout):
        raise ValueError('The default patient-disjoint path is reserved for the fixed 97/4 pre-refit model')
    if output == transductive_output and not args.refit_all:
        raise ValueError('The transductive path requires --refit-all')
    print('Computing IDF and length statistics independently inside each current patient',
          file=sys.stderr, flush=True)
    budget_values = collections.defaultdict(list)
    for pid in train_ids:
        raw = read_json(os.path.join(root, 'patients', pid + '.json'))
        for case in raw['cases']:
            admissions, _ = P.official(case)
            budget_values[(case['task']['question_type'], P.operation(case))].append(len(admissions))
    budgets = dict((key, P.percentile90(values)) for key, values in budget_values.items())
    model_path = embedding_model_path(args.embedding_model, args.allow_model_download)
    embedding_model = load_embedding_model(model_path, args.allow_model_download)
    arrays, rows, training_stats, chunk_count, embedding_dimension = collect(
        root, patient_ids, train_ids, holdout_ids, inner_ids, embedding_model,
        EMBEDDING_CHUNK_TURNS, budgets,
    )
    index = dict((value, position) for position, value in enumerate(patient_ids))
    inner_index = set(index[value] for value in inner_ids)
    train_index = set(index[value] for value in train_ids)
    admission_patient_index = arrays['admission'][3]
    turn_patient_index = arrays['turn'][3]
    admission_inner_fit = np.asarray([int(value) in train_index and int(value) not in inner_index
                                      for value in admission_patient_index], dtype=bool)
    turn_inner_fit = np.asarray([int(value) in train_index and int(value) not in inner_index
                                 for value in turn_patient_index], dtype=bool)
    admission_train_fit = np.asarray([int(value) in train_index
                                      for value in admission_patient_index], dtype=bool)
    turn_train_fit = np.asarray([int(value) in train_index
                                 for value in turn_patient_index], dtype=bool)
    admission_anchor = np.zeros(len(P.ADMISSION_FEATURES) + 3, dtype=float)
    admission_anchor[1] = 1.0;admission_anchor[2] = 0.35
    admission_anchor[9] = 0.20;admission_anchor[11] = 4.0;admission_anchor[12] = 2.0
    admission_residual = ADMISSION_ORIGINAL_RESIDUAL + (18, 19, 20)
    admission_names = tuple(P.ADMISSION_FEATURES) + ADMISSION_DENSE_NAMES
    turn_anchor = np.zeros(len(P.TURN_FEATURES), dtype=float)
    turn_anchor[0] = 1.0;turn_anchor[5] = 0.25;turn_anchor[7] = 0.10
    admission_choices = select_hyperparameters(
        'admission', arrays['admission'], rows['inner_admission'], admission_inner_fit,
        admission_anchor, admission_residual, ADMISSION_L2, (1, 2, 3, 5, 10),
    )
    admission_lexical_choices = select_hyperparameters(
        'admission', arrays['admission'], rows['inner_admission'], admission_inner_fit,
        admission_anchor, ADMISSION_ORIGINAL_RESIDUAL, ADMISSION_L2,
        (1, 2, 3, 5, 10),
    )
    turn_choices = select_hyperparameters(
        'turn', arrays['turn'], rows['inner_turn'], turn_inner_fit,
        turn_anchor, TURN_RESIDUAL, TURN_L2, (1, 3, 5, 10, 24),
    )
    admission_validation_models = fit_dispatch_models(
        arrays['admission'], admission_train_fit, admission_choices,
        admission_anchor, admission_residual,
    )
    admission_lexical_validation_models = fit_dispatch_models(
        arrays['admission'], admission_train_fit, admission_lexical_choices,
        admission_anchor, ADMISSION_ORIGINAL_RESIDUAL,
    )
    turn_validation_models = fit_dispatch_models(
        arrays['turn'], turn_train_fit, turn_choices, turn_anchor, TURN_RESIDUAL,
    )
    validation = {
        'admission': {
            'lexical_anchor': rank_metrics(
                rows['validation_admission'], admission_validation_models,
                admission_choices, admission_anchor, admission_residual,
                (1, 2, 3, 5, 10), force_gain=0.0),
            'anchored_pairwise': rank_metrics(
                rows['validation_admission'], admission_validation_models,
                admission_choices, admission_anchor, admission_residual,
                (1, 2, 3, 5, 10)),
        },
        'admission_lexical_fallback': {
            'lexical_anchor': rank_metrics(
                rows['validation_admission'], admission_lexical_validation_models,
                admission_lexical_choices, admission_anchor,
                ADMISSION_ORIGINAL_RESIDUAL, (1, 2, 3, 5, 10), force_gain=0.0),
            'anchored_pairwise': rank_metrics(
                rows['validation_admission'], admission_lexical_validation_models,
                admission_lexical_choices, admission_anchor,
                ADMISSION_ORIGINAL_RESIDUAL, (1, 2, 3, 5, 10)),
        },
        'turn': {
            'lexical_anchor': rank_metrics(
                rows['validation_turn'], turn_validation_models, turn_choices,
                turn_anchor, TURN_RESIDUAL, (1, 3, 5, 10, 24), force_gain=0.0),
            'anchored_pairwise': rank_metrics(
                rows['validation_turn'], turn_validation_models, turn_choices,
                turn_anchor, TURN_RESIDUAL, (1, 3, 5, 10, 24)),
        },
    }
    if args.refit_all:
        admission_runtime_mask = np.ones(len(arrays['admission'][0]), dtype=bool)
        turn_runtime_mask = np.ones(len(arrays['turn'][0]), dtype=bool)
        runtime_ids = patient_ids
    else:
        admission_runtime_mask = admission_train_fit
        turn_runtime_mask = turn_train_fit
        runtime_ids = train_ids
    admission_runtime_models = fit_dispatch_models(
        arrays['admission'], admission_runtime_mask, admission_choices,
        admission_anchor, admission_residual,
    )
    admission_lexical_runtime_models = fit_dispatch_models(
        arrays['admission'], admission_runtime_mask, admission_lexical_choices,
        admission_anchor, ADMISSION_ORIGINAL_RESIDUAL,
    )
    turn_runtime_models = fit_dispatch_models(
        arrays['turn'], turn_runtime_mask, turn_choices, turn_anchor, TURN_RESIDUAL,
    )
    dense_revision = (EMBEDDING_BASE_MODEL_REVISION if model_path == EMBEDDING_BASE_MODEL
                      else Path(model_path).name
                      if Path(model_path).parent.name == 'snapshots' else 'local')
    if dense_revision != EMBEDDING_BASE_MODEL_REVISION:
        raise ValueError('Loaded embedding snapshot does not match the pinned base-model revision')
    if embedding_dimension != EMBEDDING_DIMENSION:
        raise ValueError(
            'Loaded embedding dimension does not match the runtime contract: '
            + str(embedding_dimension)
        )
    core = {
        'version': VERSION,
        'benchmark': 'medlocomo',
        'runtime_eligible': True,
        'status': 'offline_validated_runtime_wired',
        'dataset_fingerprint': manifest['dataset_fingerprint'],
        'feature_contract': {
            'lexical_document_frequency_scope': 'complete_question_visible_patient_admissions',
            'average_length_scope': 'complete_question_visible_patient_admissions_and_turns',
            'dense_embedding_query': 'raw_question_nfkc_trimmed_only',
            'admission_chunk_order': 'numeric_turn_id_then_event_time_then_source_order',
            'admission_time_source': 'first_and_last_visible_source_turn',
            'admission_chunk_turn_count': EMBEDDING_CHUNK_TURNS,
            'embedding_failure_behavior': 'validated_lexical_only_ranker',
        },
        'split': {
            'method': 'patient_disjoint',
            'train_patient_count': len(train_ids),
            'validation_patient_count': len(holdout_ids),
            'inner_dev_patient_count': len(inner_ids),
            'train_set_commitment': commitment(train_ids),
            'validation_set_commitment': commitment(holdout_ids),
            'inner_dev_set_commitment': commitment(inner_ids),
            'evaluation_before_final_refit': True,
            'serialized_coefficients_match_fixed_validation_model': not bool(args.refit_all),
            'final_refit': {
                'enabled': bool(args.refit_all),
                'runtime_training_patient_count': len(runtime_ids),
                'runtime_training_set_commitment': commitment(runtime_ids),
                'validation_patients_included': bool(args.refit_all),
                'valid_for_held_out_claims': not bool(args.refit_all),
            },
        },
        'training_boundary': {
            'official_admission_labels_used': True,
            'official_exact_turn_labels_used': True,
            'same_patient_hard_negatives_used': True,
            'teacher_hard_negative_refs_used_for_training_only': True,
            'retains_patient_ids': False,
            'retains_qa_ids': False,
            'retains_question_text': False,
            'retains_gold_text': False,
            'retains_evidence_text': False,
            'retains_source_refs': False,
            'retains_case_lookup': False,
        },
        'embedding': {
            'provider': 'local',
            'model': EMBEDDING_MODEL,
            'model_revision': EMBEDDING_MODEL_REVISION,
            'model_revision_verification': 'local_snapshot_sha256',
            'base_model': EMBEDDING_BASE_MODEL,
            'base_model_revision': EMBEDDING_BASE_MODEL_REVISION,
            'snapshot_hash': EMBEDDING_SNAPSHOT_HASH,
            'snapshot_file_hashes': EMBEDDING_SNAPSHOT_FILE_HASHES,
            'revision': dense_revision,
            'pooling': 'mean',
            'normalized': True,
            'dtype': 'fp32',
            'dimension': embedding_dimension,
            'admission_chunk_turn_count': EMBEDDING_CHUNK_TURNS,
            'training_chunk_count': chunk_count,
            'runtime_contract': 'precompute normalized chunk vectors and inject three cosine features',
        },
        'objectives': {
            'admission': '0.8*official_recall_at_budget + 0.2*official_all_covered_at_budget',
            'turn': '0.75*official_recall_at_24 + 0.15*official_recall_at_5 + 0.10*mrr',
        },
        'models': {
            'admission': serialize_ranker(
                'admission', admission_runtime_models, admission_choices,
                admission_anchor, admission_residual, admission_names,
                int(np.sum(admission_runtime_mask)), ADMISSION_DENSE_NAMES,
            ),
            'admission_lexical_fallback': serialize_ranker(
                'admission_lexical_fallback', admission_lexical_runtime_models,
                admission_lexical_choices, admission_anchor,
                ADMISSION_ORIGINAL_RESIDUAL, admission_names,
                int(np.sum(admission_runtime_mask)), (),
            ),
            'turn': serialize_ranker(
                'turn', turn_runtime_models, turn_choices, turn_anchor,
                TURN_RESIDUAL, tuple(P.TURN_FEATURES),
                int(np.sum(turn_runtime_mask)), (),
            ),
        },
        'fixed_validation': validation,
    }
    artifact = dict(core)
    artifact['artifact_hash'] = hashlib.sha256(stable_json(core).encode('utf8')).hexdigest()
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = output + '.tmp-%d' % os.getpid()
    with open(temporary, 'w') as handle:
        json.dump(artifact, handle, indent=2, sort_keys=True)
        handle.write('\n')
    os.replace(temporary, output)
    print(json.dumps({
        'output': output,
        'artifact_hash': artifact['artifact_hash'],
        'refit_all': args.refit_all,
        'runtime_training_patient_count': len(runtime_ids),
        'admission_validation': validation['admission']['anchored_pairwise']['__all__'],
        'admission_lexical_fallback_validation': validation['admission_lexical_fallback']['anchored_pairwise']['__all__'],
        'turn_validation': validation['turn']['anchored_pairwise']['__all__'],
    }, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
