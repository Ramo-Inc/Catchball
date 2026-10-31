#!/usr/bin/env bash
# 使い方: ./scripts/start-claude.sh claude-a <セッションID>
set -euo pipefail
cd "${POC_SANDBOX:-$HOME/poc-sandbox}"
POC_AGENT_ID="$1" exec claude --resume "$2" --dangerously-load-development-channels server:poc_mail
