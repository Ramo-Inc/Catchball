#!/usr/bin/env bash
# 使い方: ./scripts/start-codex.sh codex-a <UUID>
set -euo pipefail
cd "${POC_SANDBOX:-$HOME/poc-sandbox}"
exec codex resume "$2" -c "mcp_servers.poc_mail.env.POC_AGENT_ID='$1'"
