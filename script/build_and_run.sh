#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="LocalHarnessAI"
APP_BUNDLE="$ROOT_DIR/local-harness-ai.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
MODULE_CACHE="/private/tmp/local-harness-ai-swift-module-cache"
SOURCES=(
  "$ROOT_DIR/launcher/QwenLocal.swift"
  "$ROOT_DIR/launcher/LauncherStore.swift"
  "$ROOT_DIR/launcher/DashboardView.swift"
  "$ROOT_DIR/launcher/AgentWorkspaceView.swift"
  "$ROOT_DIR/launcher/ToolWorkspaceView.swift"
)

pkill -TERM -x QwenLocal >/dev/null 2>&1 || true
pkill -TERM -x "$APP_NAME" >/dev/null 2>&1 || true
for _ in {1..50}; do
  pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
  sleep 0.1
done
if pgrep -x QwenLocal >/dev/null 2>&1 || pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "旧启动器未能正常退出，已取消覆盖" >&2
  exit 1
fi
mkdir -p "$MODULE_CACHE"

xcrun swiftc \
  -parse-as-library \
  -target arm64-apple-macos13.0 \
  -module-name "$APP_NAME" \
  -module-cache-path "$MODULE_CACHE" \
  -O \
  -framework SwiftUI \
  -framework AppKit \
  -framework WebKit \
  -framework Charts \
  -framework Combine \
  -framework Security \
  -framework UniformTypeIdentifiers \
  "${SOURCES[@]}" \
  -o "$APP_BINARY"

codesign --force --deep --sign - --timestamp=none "$APP_BUNDLE" >/dev/null

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "local.harness.ai"'
    ;;
  --verify|verify)
    open_app
    sleep 3
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
