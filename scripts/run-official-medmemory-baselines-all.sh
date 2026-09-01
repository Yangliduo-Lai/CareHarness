#!/bin/zsh

set -u

WORKSPACE_ROOT="${0:A:h:h}"
OFFICIAL_REPO="${MEDMEMORYBENCH_REPO:-$WORKSPACE_ROOT/data/benchmarks/MedMemoryBench}"
PYTHON="$WORKSPACE_ROOT/.venv-medmemory-baselines/bin/python"
RUNNER="$WORKSPACE_ROOT/scripts/run-official-medmemory-baseline.py"
OUTPUT_ROOT="$WORKSPACE_ROOT/reports/official-baselines/qwen3.7-plus/full-persona-1-3-5-7"
EMBEDDING_MODEL="$WORKSPACE_ROOT/.cache/models/bge-small-zh-v1.5"

if [[ -z "${CAREHARNESS_RUN_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  print -u2 "CAREHARNESS_RUN_KEY or OPENAI_API_KEY must be set"
  exit 2
fi

mkdir -p "$OUTPUT_ROOT"

run_baseline() {
  local method="$1"
  local method_dir="$OUTPUT_ROOT/$method"
  mkdir -p "$method_dir"

  local -a completed_reports
  completed_reports=("$method_dir/${method}_qwen3.7-plus"/*_result.json(N))
  if (( ${#completed_reports[@]} > 0 )); then
    print "[$(date -Iseconds)] skipping completed $method"
    return 0
  fi

  print "[$(date -Iseconds)] starting $method"

  local -a command
  command=(
    "$PYTHON" -u "$RUNNER"
    --repo "$OFFICIAL_REPO"
    --method "$method"
    --personas 1,3,5,7
    --model qwen3.7-plus
    --judge-model qwen3.7-plus
    --output-dir "$method_dir"
    --resume
    --quiet
  )
  if [[ "$method" == "amem" || "$method" == "letta" ]]; then
    command+=(--embedding-model "$EMBEDDING_MODEL")
  fi
  if [[ "$method" == "amem" ]]; then
    command+=(--amem-request-timeout-seconds 300)
  fi

  COMPOSIO_DISABLE_VERSION_CHECK=true LLM_MAX_RETRIES=3 "${command[@]}" \
    >"$method_dir/process.log" 2>&1
  local exit_status=$?
  print "[$(date -Iseconds)] finished $method status=$exit_status"
  return 0
}

run_baseline long_context
run_baseline amem
run_baseline letta

print "[$(date -Iseconds)] all baseline processes finished"
