param(
    [ValidateSet("nvidia", "intel", "amd", "all")]
    [string]$GPU = "all"
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FFmpeg ddagrab 编译脚本" -ForegroundColor Cyan
Write-Host "  GPU: $GPU" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ─── 第一步：检查 MSYS2 ──────────────────────────────────────────
Write-Host "`n[1/8] 检查 MSYS2..." -ForegroundColor Yellow

if (-not (Test-Path "C:\msys64\msys2.exe")) {
    Write-Host "❌ 未检测到 MSYS2！" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先安装 MSYS2：" -ForegroundColor White
    Write-Host "  1. 访问 https://www.msys2.org/" -ForegroundColor Gray
    Write-Host "  2. 下载 msys2-x86_64-*.exe" -ForegroundColor Gray
    Write-Host "  3. 安装到 C:\msys64" -ForegroundColor Gray
    Write-Host "  4. 安装完成后运行一次并关闭" -ForegroundColor Gray
    Write-Host ""
    Write-Host "安装完成后重新运行此脚本" -ForegroundColor Green
    exit 1
}

Write-Host "✅ MSYS2 已安装" -ForegroundColor Green

# ─── 第二步：检查 VS Build Tools ────────────────────────────────
Write-Host "`n[2/8] 检查 Visual Studio Build Tools..." -ForegroundColor Yellow

$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsInfo = & $vsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsInfo) {
        Write-Host "✅ VS Build Tools 已安装: $vsInfo" -ForegroundColor Green
    } else {
        Write-Host "⚠️ 未找到带 C++ 工具的 VS 安装" -ForegroundColor Yellow
        Write-Host "   请安装 Build Tools for Visual Studio 2022" -ForegroundColor White
        Write-Host "   勾选：'使用 C++ 的桌面开发' + 'Windows 10/11 SDK'" -ForegroundColor Gray
    }
} else {
    Write-Host "⚠️ vswhere.exe 未找到，跳过 VS 检查" -ForegroundColor Yellow
}

# ─── 第三步：生成 Configure 参数 ─────────────────────────────────
Write-Host "`n[3/8] 生成编译配置..." -ForegroundColor Yellow

$configureArgs = @(
    "--prefix=/home/$env:USERNAME/ffmpeg-build",
    "--arch=x86_64",
    "--target-os=mingw64",
    "--toolchain=mingw64",
    "--enable-gpl",
    "--enable-nonfree",
    "--enable-shared",
    "--disable-static",
    "--disable-doc",
    # 核心：ddagrab + D3D11
    "--enable-ddagrab",
    "--enable-d3d11va"
)

# 硬件编码器
switch ($GPU) {
    "nvidia" { 
        $configureArgs += @("--enable-nvenc", "--enable-hwaccel=h264_nvenc")
    }
    "intel" { 
        $configureArgs += @("--enable-qsv", "--enable-hwaccel=h264_qsv")
    }
    "amd" { 
        $configureArgs += @("--enable-amf", "--enable-hwaccel=h264_amf")
    }
    "all" {
        $configureArgs += @(
            "--enable-nvenc", "--enable-hwaccel=h264_nvenc",
            "--enable-qsv", "--enable-hwaccel=h264_qsv",
            "--enable-amf", "--enable-hwaccel=h264_amf"
        )
    }
}

$configureArgs += @(
    # 编码器和解码器
    "--encoder=libx264,libx265,h264_nvenc,h264_qsv,h264_amf,aac",
    "--decoder=h264,hevc,aac,mp3",
    # 库
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libmp3lame",
    # 过滤器和协议
    "--enable-filter=scale,crop,pad,fps,setpts",
    "--enable-protocol=file,http,tcp",
    "--enable-muxer=hls,mp4,flv,ts",
    "--enable-demuxer=mov,hls,flv,ts",
    # 优化
    '--extra-cflags="-O3 -march=native"',
    "--extra-ldflags=-static"
)

Write-Host "✅ 配置参数已生成 ($($configureArgs.Count) 个选项)" -ForegroundColor Green

# ─── 第四步：创建 MSYS2 批处理脚本 ─────────────────────────────
Write-Host "`n[4/8] 创建编译脚本..." -ForegroundColor Yellow

$msysScript = @"
#!/bin/bash
set -e

echo "========================================="
echo "  FFmpeg ddagrab 编译流程"
echo "========================================="

# 更新系统包
echo "[5/8] 更新 MSYS2 包..."
pacman -Syu --noconfirm || true
pacman -Su --noconfirm || true

# 安装依赖
echo "[6/8] 安装编译依赖..."
pacman -S --noconfirm --needed `
  base-devel git yasm nasm pkg-config diffutils `
  mingw-w64-x86_64-toolchain mingw-w64-x86_64-dlfcn `
  mingw-w64-x86_64-freetype `
  mingw-w64-x86_64-libass `
  mingw-w64-x86_64-libvpx `
  mingw-w64-x86_64-libvorbis `
  mingw-w64-x86_64-libmp3lame

# 获取源码
echo "[7/8] 获取 FFmpeg 源码..."
cd ~
if [ ! -d "ffmpeg-src" ]; then
    git clone https://github.com/FFmpeg/FFmpeg.git ffmpeg-src
fi
cd ffmpeg-src
git checkout n7.0
git pull

# 配置
echo "[8/8] 配置并编译 FFmpeg..."
./configure $($configureArgs -join ' ')

# 编译（使用所有 CPU 核心）
make -j$(nproc)

# 安装
make install

echo ""
echo "========================================="
echo "✅ 编译完成！"
echo "========================================="
echo ""
echo "产物位置: ~/ffmpeg-build/bin/"
echo "验证命令:"
echo "  cd ~/ffmpeg-build/bin"
echo "  ./ffmpeg.exe -formats | grep ddagrab"
echo ""

# 验证
cd ~/ffmpeg-build/bin
./ffmpeg.exe -formats 2>&1 | grep -i ddagrab && echo "✅ ddagrab 已启用！" || echo "❌ ddagrab 未启用"
"@

$scriptPath = "$env:TEMP\build-ffmpeg.sh"
$msysScript | Out-File -FilePath $scriptPath -Encoding utf8

Write-Host "✅ 编译脚本已创建: $scriptPath" -ForegroundColor Green

# ─── 第五步：启动 MSYS2 执行编译 ────────────────────────────────
Write-Host "`n🚀 准备启动 MSYS2 编译环境..." -ForegroundColor Cyan
Write-Host ""
Write-Host "接下来的步骤：" -ForegroundColor White
Write-Host "  1. MSYS2 窗口将自动打开" -ForegroundColor Gray
Write-Host "  2. 在 MSYS2 中执行: bash $scriptPath" -ForegroundColor Gray
Write-Host "  3. 等待编译完成（10-30 分钟）" -ForegroundColor Gray
Write-Host ""
Write-Host "按任意键继续..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

& "C:\msys64\msys2.exe" -ucrt64 -where c:\ -c "bash $scriptPath"