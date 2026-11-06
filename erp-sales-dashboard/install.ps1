<#
  install.ps1 —— ERP 销售仪表盘插件安装器（Windows 薄包装）
  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 --profile desktop --force
  本脚本只做两件事：找到 node、把参数原样转给 install.mjs，并透传退出码。
#>

# 兼容 PowerShell 5.1 与 7+：不要让原生命令的非零退出码在 Stop 模式下抛异常
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-NodeExe {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        $p = $cmd.Source
        if (-not $p) { $p = $cmd.Definition }
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:APPDATA 'npm\node.exe'),
        (Join-Path $env:ProgramData 'chocolatey\bin\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

$Node = Find-NodeExe
if (-not $Node) {
    Write-Host ''
    Write-Host '✘ 找不到 Node.js。' -ForegroundColor Red
    Write-Host '  请先安装 Node.js 18 或更高版本：https://nodejs.org/'
    Write-Host ''
    exit 1
}

$Target = Join-Path $ScriptDir 'install.mjs'
& $Node $Target @args
$code = $LASTEXITCODE
exit $code
