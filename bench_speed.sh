#!/usr/bin/env bash
# 非交互压测
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/llama_cpp_bonsai/build/bin/llama-cli"
MODEL="$ROOT/Ternary-Bonsai-2-27B-PTQ1_0.gguf"
LOG="${LOG:-/tmp/llama_iq2_bench.log}"
OUT="${OUT:-/tmp/llama_iq2_bench_out.txt}"

CTX="${CTX:-2048}"
KV="${KV:-q4_0}"
NGL="${NGL:-99}"
THREADS="${THREADS:-4}"
N_PREDICT="${N_PREDICT:-64}"
MOE="${MOE:-0}"
SPEC="${SPEC:-0}"

ARGS=(
  -m "$MODEL"
  -ngl "$NGL"
  -c "$CTX"
  -fa on
  -ctk "$KV"
  -ctv "$KV"
  -t "$THREADS"
  -tb "$THREADS"
  -b 512
  -ub 128
  --mmap
  --fit off
  -no-cnv
  -n "$N_PREDICT"
  --temp 0.7
  --top-k 20
  --top-p 0.95
  -p "用简洁中文解释什么是投机解码，并举一个短例子。"
  --log-file "$LOG"
  --no-display-prompt
)

if [[ "$MOE" == "1" ]]; then
  ARGS+=(--cpu-moe)
fi

if [[ "$SPEC" == "1" ]]; then
  ARGS+=(--spec-type ngram-mod --spec-ngram-mod-n-min 2 --spec-ngram-mod-n-max 4 --spec-ngram-mod-n-match 16)
fi

echo "==== bench KV=${KV} MOE=${MOE} CTX=${CTX} n=${N_PREDICT} ===="
"$BIN" "${ARGS[@]}" >"$OUT" 2>&1
echo "exit=$?"
echo "==== 速度 ===="
rg -n 'load time =|prompt eval time =|eval time =' "$OUT" || true
echo "==== 文本 ===="
tr -d '\000-\010\013\014\016-\037' <"$OUT" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' \
  | rg -v '^[0-9]+\.[0-9]|sampler |system_info|generate:|common_|llama_|Loading' | head -40
