# 使い方: .\scripts\start-claude.ps1 -Agent claude-a -Session <セッションID>
# poc-sandbox で、テスト用の Claude セッションを開発用 Channel 付きで再開する
param([Parameter(Mandatory)][string]$Agent, [Parameter(Mandatory)][string]$Session, [string]$Sandbox = "$HOME\poc-sandbox")
Set-Location $Sandbox
$env:POC_AGENT_ID = $Agent
claude --resume $Session --dangerously-load-development-channels server:poc_mail
