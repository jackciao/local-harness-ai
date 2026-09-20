#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/xavierciao/Documents/offline models"
APP="$ROOT/local-harness-ai.app"

[[ -d "$APP" ]] || { echo "未找到 $APP" >&2; exit 1; }
/usr/bin/open "$APP"
