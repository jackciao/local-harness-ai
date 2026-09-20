#!/usr/bin/env bash
# Ternary Bonsai 2 27B PTQ1_0 @ Apple Silicon
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/llama_cpp_bonsai/build/bin/llama-cli"
MODEL="$ROOT/Ternary-Bonsai-2-27B-PTQ1_0.gguf"

# 覆盖示例：
#   CTX=4096 KV=q8_0 ./run_chat.sh
#   MOE=1 ./run_chat.sh
#   SPEC=0 ./run_chat.sh
#   REASONING=auto ./run_chat.sh   # 打开思考链（慢）
CTX="${CTX:-2048}"
KV="${KV:-q4_0}"
NGL="${NGL:-99}"
THREADS="${THREADS:-4}"
BATCH="${BATCH:-512}"
UBATCH="${UBATCH:-128}"
SPEC="${SPEC:-0}"
MOE="${MOE:-0}"
REASONING="${REASONING:-off}"
NGRAM_MIN="${NGRAM_MIN:-2}"
NGRAM_MAX="${NGRAM_MAX:-4}"
NGRAM_MATCH="${NGRAM_MATCH:-16}"

[[ -x "$BIN" ]] || { echo "未找到 llama-cli：$BIN" >&2; exit 1; }
[[ -f "$MODEL" ]] || { echo "未找到模型：$MODEL" >&2; exit 1; }

# zsh 交互下 # 不是注释：过滤误粘贴的 "# xxx"
FORWARD_ARGS=()
for a in "$@"; do
  [[ "$a" == \#* || "$a" == \# ]] && break
  FORWARD_ARGS+=("$a")
done

ARGS=(
  -m "$MODEL"
  -ngl "$NGL"
  -c "$CTX"
  -fa on
  -ctk "$KV"
  -ctv "$KV"
  -t "$THREADS"
  -tb "$THREADS"
  -b "$BATCH"
  -ub "$UBATCH"
  --mmap
  --fit off
  -cnv
  --jinja
  --reasoning "$REASONING"
  --temp 1.0
  --top-k 20
  --top-p 0.95
  --min-p 0.0
  --repeat-penalty 1.0
)

if [[ "$MOE" == "1" ]]; then
  ARGS+=(--cpu-moe)
fi

if [[ "$SPEC" == "1" ]]; then
  # ponytail: ngram stays opt-in; use only when repetitive multi-turn text raises acceptance.
  ARGS+=(
    --spec-type ngram-mod
    --spec-ngram-mod-n-min "$NGRAM_MIN"
    --spec-ngram-mod-n-max "$NGRAM_MAX"
    --spec-ngram-mod-n-match "$NGRAM_MATCH"
  )
fi

echo "启动对话: $(basename "$MODEL")"
echo "  ctx=${CTX} KV=${KV} ngl=${NGL} moe=${MOE} flash-attn ngram=${SPEC} reasoning=${REASONING}"
exec "$BIN" "${ARGS[@]}" "${FORWARD_ARGS[@]}"
