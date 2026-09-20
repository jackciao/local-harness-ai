#!/usr/bin/env bash
# OpenAI 兼容 HTTP 服务（默认 http://127.0.0.1:7890）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/llama_cpp_bonsai/build/bin/llama-server"
MODEL="${MODEL:-$ROOT/Ternary-Bonsai-2-27B-PTQ1_0.gguf}"

CTX="${CTX:-8192}"
KV="${KV:-q4_0}"
NGL="${NGL:-99}"
THREADS="${THREADS:-1}"
THREADS_BATCH="${THREADS_BATCH:-8}"
BATCH="${BATCH:-512}"
UBATCH="${UBATCH:-512}"
LISTEN_HOST="${QWEN_HOST:-127.0.0.1}"
LISTEN_PORT="${QWEN_PORT:-7890}"
SPEC="${SPEC:-0}"
MOE="${MOE:-0}"
REASONING="${REASONING:-off}"
NGRAM_MIN="${NGRAM_MIN:-2}"
NGRAM_MAX="${NGRAM_MAX:-4}"
NGRAM_MATCH="${NGRAM_MATCH:-16}"
CACHE_RAM="${CACHE_RAM:-1024}"
LOAD_MODE="${LOAD_MODE:-none}"
FLASH_ATTN="${FLASH_ATTN:-on}"
FIT_CTX="${FIT_CTX:-4096}"
MMPROJ="${MMPROJ:-}"
CHAT_TEMPLATE="${CHAT_TEMPLATE:-}"

[[ -x "$BIN" ]] || { echo "未找到 llama-server：$BIN" >&2; exit 1; }
[[ -f "$MODEL" ]] || { echo "未找到模型：$MODEL" >&2; exit 1; }
[[ -z "$MMPROJ" || -f "$MMPROJ" ]] || { echo "未找到视觉投影：$MMPROJ" >&2; exit 1; }

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
  -fa "$FLASH_ATTN"
  -ctk "$KV"
  -ctv "$KV"
  -t "$THREADS"
  -tb "$THREADS_BATCH"
  -b "$BATCH"
  -ub "$UBATCH"
  --load-mode "$LOAD_MODE"
  --fit on
  --fit-ctx "$FIT_CTX"
  --cache-ram "$CACHE_RAM"
  -np 1
  --host "$LISTEN_HOST"
  --port "$LISTEN_PORT"
  -a qwen
  --jinja
  --reasoning "$REASONING"
  --temp 1.0
  --top-k 20
  --top-p 0.95
)

[[ -n "$MMPROJ" ]] && ARGS+=(-mm "$MMPROJ")
[[ -n "$CHAT_TEMPLATE" ]] && ARGS+=(--chat-template "$CHAT_TEMPLATE")

if [[ "$MOE" == "1" ]]; then
  ARGS+=(--cpu-moe)
fi

if [[ "$SPEC" == "1" ]]; then
  # ponytail: ngram stays opt-in; this model measured 1.6-4.7% acceptance on free-form prompts.
  ARGS+=(
    --spec-type ngram-mod
    --spec-ngram-mod-n-min "$NGRAM_MIN"
    --spec-ngram-mod-n-max "$NGRAM_MAX"
    --spec-ngram-mod-n-match "$NGRAM_MATCH"
  )
fi

echo "启动服务: http://${LISTEN_HOST}:${LISTEN_PORT}"
echo "  模型: $(basename "$MODEL")"
echo "  ctx=${CTX} KV=${KV} ngl=${NGL} moe=${MOE} flash-attn=${FLASH_ATTN} ngram=${SPEC} reasoning=${REASONING} load=${LOAD_MODE} cache-ram=${CACHE_RAM}M"
if (( ${#FORWARD_ARGS[@]} )); then
  exec "$BIN" "${ARGS[@]}" "${FORWARD_ARGS[@]}"
else
  exec "$BIN" "${ARGS[@]}"
fi
