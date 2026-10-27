$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 20以上が必要です。社内で承認された方法でNode.jsをインストールしてから再実行してください。' }
& $nodeCommand.Source (Join-Path $PSScriptRoot 'scripts\install.mjs')
if ($LASTEXITCODE -ne 0) { throw 'インストールに失敗しました。上記の内容を確認してください。' }
Write-Host 'インストールしました。Codexを再起動し、$jopt-event-register と2つのポータルURLを送ってください。'
