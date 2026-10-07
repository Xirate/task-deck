# Builds TaskDeck.exe with the C# compiler that ships with Windows (.NET Framework 4.x) - nothing to install.
# The pages in web\ are embedded, so the exe works on its own.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw ".NET Framework 4.x compiler (csc.exe) not found." }

$web = Join-Path $PSScriptRoot 'web'
$out = Join-Path $PSScriptRoot 'TaskDeck.exe'
$resources = Get-ChildItem $web -File | ForEach-Object { "/resource:$($_.FullName),$($_.Name)" }

& $csc /nologo /target:winexe /optimize+ "/out:$out" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
    $resources (Join-Path $PSScriptRoot 'TaskDeck.cs')
if ($LASTEXITCODE -ne 0) { throw "Build failed (is TaskDeck.exe still running? Exit it from the tray first)" }
Write-Host "Built $out"
