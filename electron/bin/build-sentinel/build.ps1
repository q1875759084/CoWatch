# 打包 window_sentinel.py → electron/bin/window_sentinel.exe
# 单文件 / 无控制台(--noconsole) / 禁用 UPX(--noupx，规避杀软误报)
# 在 build-sentinel/ 目录执行，--distpath .. 使产物直接落到 electron/bin/

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $ScriptDir

try {
    # 优先使用虚拟环境内的 pyinstaller；若不在 PATH 则回退到 python -m PyInstaller
    $pyinstaller = "pyinstaller"
    if (-not (Get-Command pyinstaller -ErrorAction SilentlyContinue)) {
        $pyinstaller = "python -m PyInstaller"
    }

    Invoke-Expression "$pyinstaller -F --name window_sentinel --noconsole --noupx --distpath .. window_sentinel.py"
}
finally {
    Pop-Location
}
