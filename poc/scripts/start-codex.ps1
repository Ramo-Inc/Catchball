# 使い方: .\scripts\start-codex.ps1 -Agent codex-a -Thread <UUID>
# poc-sandbox で、テスト用の Codex セッションを PoC 用の ID 付きで再開する
param([Parameter(Mandatory)][string]$Agent, [Parameter(Mandatory)][string]$Thread, [string]$Sandbox = "$HOME\poc-sandbox")
Set-Location $Sandbox
codex resume $Thread -c "mcp_servers.poc_mail.env.POC_AGENT_ID='$Agent'"
