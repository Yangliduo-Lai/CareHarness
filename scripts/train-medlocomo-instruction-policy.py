#!/usr/bin/env python3
"""Train the MedLoCoMo question-token search-instruction prior.

The teacher uses official Evidence only as an offline binary label: a token
copied from the runtime Question is useful when it occurs in the teacher's
selected source Turns.  The serialized model contains only aggregate numeric
coefficients and split/metric commitments; it never stores a patient id,
question, answer, source Turn, or Evidence reference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression


VERSION = "medlocomo-instruction-salience.v1-patient-disjoint"
HOLDOUT = ("10913302", "11021643", "11441519", "11826927")
TYPES = (
    "adversarial", "care_plan_rationale", "cross_admission_comparison",
    "frequency_pattern", "longitudinal_progression", "medical_reasoning",
)
TYPE_INDEX = {value: index for index, value in enumerate(TYPES)}
TOKEN_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*|\d+(?:\.\d+)?")
STOP = set((
    "a an the and or of for to in on at by as was were is are be been being with "
    "from during which what when where why how did does do had has have his her "
    "their this that these those into after before over time patient patients "
    "hospitalization hospitalizations admission admissions across multiple "
    "because due while most primary main following according record records "
    "tell describe explain compare between regarding related all"
).split())
QUESTION_WORDS = set("what which when where why how who whose whom did does do is are was were can could would should".split())
TEMPORAL = set("initial initially earliest first baseline final finally latest last eventually ultimately discharge progression progressed over time".split())
COMPARISON = set("compare comparison compared differ difference different similar versus vs between change changed increase decrease higher lower".split())
CAUSAL = set("why reason rationale explains explain cause caused because due despite".split())
NEGATION = set("no not never none without denied denies negative absent cannot unable unlikely".split())
GENERIC_FEATURES = (
    "bias", "relative_position", "reverse_position", "log_length", "is_numeric",
    "has_hyphen", "was_uppercase", "is_stop", "is_question_word",
    "is_temporal_cue", "is_comparison_cue", "is_causal_cue", "is_negation",
    "suffix_ing", "suffix_ed", "suffix_ion", "suffix_ity", "suffix_osis",
    "suffix_emia", "suffix_ectomy", "suffix_therapy", "prefix_anti",
    "prefix_hyper", "prefix_hypo", "type_intercept_0", "type_intercept_1",
    "type_intercept_2", "type_intercept_3", "type_intercept_4", "type_intercept_5",
)
TOKEN_BUCKETS = 512
CHAR_BUCKETS = 256
FEATURE_COUNT = len(GENERIC_FEATURES) + TOKEN_BUCKETS + CHAR_BUCKETS


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-root", default="data/medlocomo-full-distillation")
    parser.add_argument("--output", default="data/medlocomo-hierarchical-distillation/instruction-policy.json")
    parser.add_argument("--max-terms", type=int, default=4)
    return parser.parse_args()


def stable_json(value):
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(str(key), ensure_ascii=False) + ":" + stable_json(value[key]) for key in sorted(value)) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_json(item) for item in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        absolute = abs(value)
        if 1e-6 <= absolute < 1e21:
            return format(Decimal(str(value)), "f")
        return re.sub(r"e([+-])0+(\d+)$", r"e\1\2", str(value))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256(value):
    if not isinstance(value, str):
        value = stable_json(value)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fnv1a(value):
    state = 2166136261
    for byte in value.encode("utf-8"):
        state ^= byte
        state = (state * 16777619) & 0xFFFFFFFF
    return state


def stem(token):
    if token.isdigit() or len(token) < 5:
        return token
    if token.endswith("ies") and len(token) > 5:
        return token[:-3] + "y"
    for suffix in ("ingly", "edly", "ing", "ed"):
        if token.endswith(suffix) and len(token) > len(suffix) + 3:
            return token[:-len(suffix)]
    if token.endswith("es") and len(token) > 6:
        return token[:-2]
    if token.endswith("s") and len(token) > 6 and not token.endswith(("sis", "ous")):
        return token[:-1]
    return token


def question_tokens(text):
    rows = []
    seen = set()
    matches = list(TOKEN_RE.finditer(text or ""))
    for match in matches:
        surface = match.group(0)
        normalized = surface.lower()
        if normalized in seen or len(normalized) < 2:
            continue
        seen.add(normalized)
        rows.append({"surface": surface, "token": normalized, "position": len(rows)})
    count = max(1, len(rows) - 1)
    for row in rows:
        row["relative_position"] = row["position"] / count
        row["total"] = len(rows)
    return rows


def normalized_terms(text):
    values = set()
    for token in TOKEN_RE.findall(text or ""):
        low = token.lower()
        values.add(low)
        values.add(stem(low))
    return values


def char_grams(token):
    padded = f"^{token}$"
    return [padded[index:index + 3] for index in range(max(0, len(padded) - 2))]


def features(row, question_type):
    token = row["token"]
    values = {
        0: 1.0,
        1: row["relative_position"],
        2: 1.0 - row["relative_position"],
        3: math.log1p(len(token)) / math.log(24),
        4: float(bool(re.fullmatch(r"\d+(?:\.\d+)?", token))),
        5: float("-" in token),
        6: float(row["surface"].isupper() and len(row["surface"]) > 1),
        7: float(token in STOP),
        8: float(token in QUESTION_WORDS),
        9: float(token in TEMPORAL),
        10: float(token in COMPARISON),
        11: float(token in CAUSAL),
        12: float(token in NEGATION),
        13: float(token.endswith("ing")),
        14: float(token.endswith("ed")),
        15: float(token.endswith("ion")),
        16: float(token.endswith("ity")),
        17: float(token.endswith("osis")),
        18: float(token.endswith("emia")),
        19: float(token.endswith("ectomy")),
        20: float(token.endswith("therapy")),
        21: float(token.startswith("anti")),
        22: float(token.startswith("hyper")),
        23: float(token.startswith("hypo")),
    }
    type_index = TYPE_INDEX.get(question_type)
    if type_index is not None:
        values[24 + type_index] = 1.0
    values[len(GENERIC_FEATURES) + fnv1a("t:" + token) % TOKEN_BUCKETS] = 1.0
    for gram in set(char_grams(token)):
        index = len(GENERIC_FEATURES) + TOKEN_BUCKETS + fnv1a("g:" + gram) % CHAR_BUCKETS
        values[index] = values.get(index, 0.0) + 1.0 / max(1, len(set(char_grams(token))))
    return values


def load_cases(root):
    manifest = json.loads((root / "manifest.json").read_text())
    cases = []
    for shard in manifest["shards"]:
        raw = json.loads((root / shard["path"]).read_text())
        turns = {row["source_ref"]: row for row in raw.get("source_turns", [])}
        turns_by_admission = defaultdict(list)
        for row in raw.get("source_turns", []):
            turns_by_admission[str(row.get("admission_id", ""))].append(row)
        for case in raw.get("cases", []):
            target_refs = case.get("retrieval_teacher", {}).get("final_state", {}).get("selected_source_refs", [])
            target_rows = [turns[ref] for ref in target_refs if ref in turns]
            if not target_rows:
                for admission in case.get("supervision", {}).get("official_evidence", {}).get("admission_ids", []):
                    target_rows.extend(turns_by_admission.get(str(admission), []))
            evidence_terms = normalized_terms(" ".join(str(row.get("text", "")) for row in target_rows))
            tokens = question_tokens(case.get("task", {}).get("question", ""))
            for row in tokens:
                row["label"] = int(row["token"] in evidence_terms or stem(row["token"]) in evidence_terms)
            cases.append({
                "patient": str(raw["patient_id"]),
                "type": case.get("task", {}).get("question_type", ""),
                "scope": case.get("task", {}).get("scope", ""),
                "tokens": tokens,
                "turns": raw.get("source_turns", []),
                "target_refs": set(case.get("supervision", {}).get("official_evidence", {}).get("turn_refs", [])),
                "target_admissions": set(str(x) for x in case.get("supervision", {}).get("official_evidence", {}).get("admission_ids", [])),
            })
    return manifest, cases


def sparse_rows(cases, pairwise=True):
    rows, cols, values, labels = [], [], [], []
    row_index = 0
    for case in cases:
        positives = [token for token in case["tokens"] if token["label"]]
        negatives = [token for token in case["tokens"] if not token["label"]]
        if pairwise and positives and negatives:
            for p_index, positive in enumerate(positives):
                for negative in negatives[: min(4, len(negatives))]:
                    p = features(positive, case["type"])
                    n = features(negative, case["type"])
                    diff = {key: p.get(key, 0.0) - n.get(key, 0.0) for key in set(p) | set(n)}
                    for sign, label in ((1.0, 1), (-1.0, 0)):
                        for key, value in diff.items():
                            if value:
                                rows.append(row_index); cols.append(key); values.append(sign * value)
                        labels.append(label); row_index += 1
        else:
            for token in case["tokens"]:
                for key, value in features(token, case["type"]).items():
                    rows.append(row_index); cols.append(key); values.append(value)
                labels.append(token["label"]); row_index += 1
    return csr_matrix((values, (rows, cols)), shape=(row_index, FEATURE_COUNT)), np.asarray(labels)


def score_token(model, row, question_type):
    return float(model.intercept_[0] + sum(model.coef_[0, key] * value for key, value in features(row, question_type).items()))


def ranked_terms(model, case, limit):
    rows = [row for row in case["tokens"] if row["token"] not in STOP and row["token"] not in QUESTION_WORDS]
    rows.sort(key=lambda row: (-score_token(model, row, case["type"]), row["position"]))
    return rows[:limit]


def baseline_terms(case, limit):
    return [row for row in case["tokens"] if row["token"] not in STOP and row["token"] not in QUESTION_WORDS][:limit]


def token_metrics(cases, selector, limit):
    precision, recall, hits = [], [], []
    for case in cases:
        positives = sum(row["label"] for row in case["tokens"])
        selected = selector(case, limit)
        matched = sum(row["label"] for row in selected)
        precision.append(matched / max(1, len(selected)))
        recall.append(matched / max(1, positives))
        hits.append(float(matched > 0))
    return {"precision_at_k": mean(precision), "positive_recall_at_k": mean(recall), "any_positive_at_k": mean(hits)}


def retrieval_metrics(cases, selector, limit):
    exact_recall, exact_all, admission_recall, admission_all = [], [], [], []
    for case in cases:
        selected = selector(case, limit)
        terms = [(row["token"], max(0.05, getattr(row, "score", 1.0) if not isinstance(row, dict) else row.get("weight", 1.0))) for row in selected]
        if not terms:
            continue
        scored = []
        for index, turn in enumerate(case["turns"]):
            doc = normalized_terms(turn.get("text", ""))
            score = sum(weight for term, weight in terms if term in doc or stem(term) in doc)
            scored.append((score, -index, turn.get("source_ref", ""), str(turn.get("admission_id", ""))))
        ranked = sorted(scored, reverse=True)[:24]
        selected_refs = {row[2] for row in ranked if row[0] > 0}
        selected_admissions = {row[3] for row in ranked if row[0] > 0}
        if case["target_refs"]:
            covered = len(case["target_refs"] & selected_refs)
            exact_recall.append(covered / len(case["target_refs"]))
            exact_all.append(float(covered == len(case["target_refs"])))
        if case["target_admissions"]:
            covered = len(case["target_admissions"] & selected_admissions)
            admission_recall.append(covered / len(case["target_admissions"]))
            admission_all.append(float(covered == len(case["target_admissions"])))
    return {
        "exact_turn_recall_at_24": mean(exact_recall), "all_exact_turns_at_24": mean(exact_all),
        "evidence_admission_recall_at_24": mean(admission_recall), "all_evidence_admissions_at_24": mean(admission_all),
        "exact_turn_case_count": len(exact_recall), "admission_case_count": len(admission_recall),
    }


def mean(values):
    return round(sum(values) / len(values), 6) if values else 0.0


def commitment(values):
    # Match the fixed patient-set commitment used by the independent pairwise
    # and Action trainers.  This commits only to membership, never case data.
    return hashlib.sha256("\n".join(sorted(set(str(value) for value in values))).encode("utf-8")).hexdigest()


def main():
    args = parse_args()
    root, output = Path(args.teacher_root), Path(args.output)
    manifest, cases = load_cases(root)
    train = [case for case in cases if case["patient"] not in HOLDOUT]
    validation = [case for case in cases if case["patient"] in HOLDOUT]
    if len(set(case["patient"] for case in train)) != 97 or len(set(case["patient"] for case in validation)) != 4:
        raise RuntimeError("Expected fixed 97/4 patient-disjoint split")
    matrix, labels = sparse_rows(train)
    model = LogisticRegression(C=0.35, max_iter=400, solver="liblinear", random_state=42, fit_intercept=True)
    model.fit(matrix, labels)
    for case in validation:
        for row in case["tokens"]:
            row["weight"] = 1.0 + max(0.0, score_token(model, row, case["type"]))
    baseline_token = token_metrics(validation, baseline_terms, args.max_terms)
    learned_token = token_metrics(validation, lambda case, limit: ranked_terms(model, case, limit), args.max_terms)
    baseline_retrieval = retrieval_metrics(validation, baseline_terms, args.max_terms)
    learned_retrieval = retrieval_metrics(validation, lambda case, limit: ranked_terms(model, case, limit), args.max_terms)
    patients = sorted(set(case["patient"] for case in cases))
    accepted = (
        learned_token["precision_at_k"] >= baseline_token["precision_at_k"]
        and learned_token["any_positive_at_k"] >= baseline_token["any_positive_at_k"]
        and learned_retrieval["exact_turn_recall_at_24"] >= baseline_retrieval["exact_turn_recall_at_24"]
        and learned_retrieval["evidence_admission_recall_at_24"] >= baseline_retrieval["evidence_admission_recall_at_24"]
        and (learned_retrieval["exact_turn_recall_at_24"] > baseline_retrieval["exact_turn_recall_at_24"]
             or learned_retrieval["evidence_admission_recall_at_24"] > baseline_retrieval["evidence_admission_recall_at_24"])
    )
    body = {
        "version": VERSION,
        "benchmark": "medlocomo",
        "status": "offline_validated_pending_production_search_ab",
        "runtime_eligible": False,
        "training_boundary": {
            "teacher_manifest_version": manifest["version"],
            "teacher_manifest_hash": manifest["artifact_hash"],
            "official_evidence_used_as_offline_labels": True,
            "runtime_reads_official_evidence": False,
            "runtime_terms_are_copied_only_from_current_question": True,
            "retains_patient_ids": False,
            "retains_qa_ids": False,
            "retains_question_text": False,
            "retains_gold_or_answer_text": False,
            "retains_evidence_text_or_source_refs": False,
            "valid_for_held_out_claims": True,
        },
        "split": {
            "method": "fixed_patient_disjoint_97_train_4_validation",
            "train_patient_count": 97,
            "validation_patient_count": 4,
            "train_question_count": len(train),
            "validation_question_count": len(validation),
            "train_set_commitment": commitment(patient for patient in patients if patient not in HOLDOUT),
            "validation_set_commitment": commitment(HOLDOUT),
            "serialized_coefficients_match_validation_model": True,
            "final_refit": False,
        },
        "feature_contract": {
            "tokenizer": "ascii_word_hyphen_decimal_v1",
            "candidate_source": "unique_tokens_copied_from_runtime_question",
            "model": "pairwise_logistic_regression_with_feature_hashing",
            "generic_feature_names": list(GENERIC_FEATURES),
            "token_hash": "fnv1a_utf8_512",
            "character_trigram_hash": "fnv1a_utf8_256",
            "question_type_intercepts": list(TYPES),
            "max_augmented_terms": args.max_terms,
            "stop_component": "not_trained_no_runtime_gate",
        },
        "acceptance": {
            "accepted": False,
            "patient_disjoint": True,
            "criteria": "token precision, any-hit, exact-Turn recall@24, and Evidence-Admission recall@24 must all be non-inferior; one retrieval metric must strictly improve",
            "evaluated_on": "fixed_4_patient_validation_split",
        },
        "deployment": {
            "enabled_by_default": False,
            "mode": "conditional_sparse_or_prior_no_progress_augmentation",
            "blind_augmentation_for_rich_llm_instructions": False,
            "sparse_definition": "exactly_one_explicit_lexical_term_and_no_numeric_or_lens_control_and_not_term_match_all",
            "prior_no_progress_definition": "a_previous_discovery_with_zero_recall_or_zero_new_nodes_enables_one_bounded_question_term_augmentation",
            "stop_gate_enabled": False,
        },
        "model": {
            "intercept": round(float(model.intercept_[0]), 10),
            "coefficients": [round(float(value), 10) for value in model.coef_[0]],
        },
        "validation": {
            "token_utility_label": "question_token_occurs_in_teacher_selected_source_turns",
            "baseline": {"selection": "first_non_stop_question_tokens", "token": baseline_token, "retrieval": baseline_retrieval},
            "learned": {"selection": "top_pairwise_salience_question_tokens", "token": learned_token, "retrieval": learned_retrieval},
            "delta": {
                "token_precision_at_k": round(learned_token["precision_at_k"] - baseline_token["precision_at_k"], 6),
                "token_any_positive_at_k": round(learned_token["any_positive_at_k"] - baseline_token["any_positive_at_k"], 6),
                "exact_turn_recall_at_24": round(learned_retrieval["exact_turn_recall_at_24"] - baseline_retrieval["exact_turn_recall_at_24"], 6),
                "evidence_admission_recall_at_24": round(learned_retrieval["evidence_admission_recall_at_24"] - baseline_retrieval["evidence_admission_recall_at_24"], 6),
            },
        },
    }
    body["artifact_hash"] = sha256(body)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "artifact_hash": body["artifact_hash"], "training_rows": int(matrix.shape[0]), "validation": body["validation"]}, indent=2))


if __name__ == "__main__":
    main()
