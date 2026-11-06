<#
  check-install.ps1 —— ERP 销售仪表盘插件安装状态核对（Windows 薄包装，只读）
  用法：
    powershell -ExecutionPolicy Bypass -File .\check-install.ps1
    powershell -ExecutionPolicy Bypass -File .\check-install.ps1 --profile desktop
#>

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

$Target = Join-Path $ScriptDir 'check-install.mjs'
& $Node $Target @args
$code = $LASTEXITCODE
exit $code
