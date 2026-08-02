# Build window_sentinel.py -> electron/bin/window_sentinel.exe
# onefile / no console (--noconsole) / no UPX (--noupx to avoid AV false positives)
# Run inside build-sentinel/, --distpath .. lands output in electron/bin/

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $ScriptDir

try {
    $pyi = "pyinstaller"
    if (-not (Get-Command pyinstaller -ErrorAction SilentlyContinue)) {
        if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
            Write-Error "PyInstaller not found and 'python' is not on PATH. Install it with: pip install pyinstaller"
            exit 1
        }
        $pyi = "python -m PyInstaller"
    }

    Write-Host "[build-sentinel] Using: $pyi"
    Invoke-Expression "$pyi -F --name window_sentinel --noconsole --noupx --distpath .. window_sentinel.py"

    if (-not (Test-Path "..\window_sentinel.exe")) {
        Write-Error "Build completed but window_sentinel.exe was not produced."
        exit 1
    }
    Write-Host "[build-sentinel] Success: ..\window_sentinel.exe"
}
finally {
    Pop-Location
}
