#!/bin/bash
set -e

echo "========================================="
echo "  FFmpeg 编译依赖安装脚本 (v2)"
echo "========================================="

echo ""
echo "[1/6] 切换到国内镜像源..."
# 使用清华镜像（稳定快速）
cat > /etc/pacman.d/mirrorlist.mingw64 << 'EOF'
Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/mingw/x86_64/
Server = https://mirror.bit.edu.cn/msys2/mingw/x86_64/
Server = https://mirrors.aliyun.com/msys2/mingw/x86_64/
EOF

cat > /etc/pacman.d/mirrorlist.ucrt64 << 'EOF'
Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/ucrt64/x86_64/
Server = https://mirror.bit.edu.cn/msys2/ucrt64/x86_64/
Server = https://mirrors.aliyun.com/msys2/ucrt64/x86_64/
EOF

cat > /etc/pacman.d/mirrorlist.msys << 'EOF'
Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/msys/$arch/
Server = https://mirror.bit.edu.cn/msys2/msys/$arch/
Server = https://mirrors.aliyun.com/msys2/msys/$arch/
EOF

echo "✅ 镜像源已切换"

echo ""
echo "[2/6] 更新包数据库..."
pacman -Sy --noconfirm || true

echo ""
echo "[3/6] 安装基础工具链..."
pacman -S --needed --noconfirm base-devel git yasm nasm pkg-config diffutils

echo ""
echo "[4/6] 安装 Windows 编译工具..."
pacman -S --needed --noconfirm mingw-w64-x86_64-toolchain mingw-w64-x86_64-dlfcn

echo ""
echo "[5/6] 安装 FFmpeg 核心库 (修正版)..."
pacman -S --needed --noconfirm \
  mingw-w64-x86_64-freetype \
  mingw-w64-x86_64-libass \
  mingw-w64-x86_64-libvpx \
  mingw-w64-x86_64-libvorbis \
  mingw-w64-x86_64-lame \
  mingw-w64-x86_64-x264 \
  mingw-w64-x86_64-x265

echo ""
echo "[6/6] 验证安装..."
echo "-----------------------------------------"
gcc --version | head -1
nasm --version | head -1
pkg-config --version | head -1
echo "-----------------------------------------"

echo ""
echo "✅ 所有依赖安装完成！"
echo "   现在可以继续编译 FFmpeg 了"
echo "========================================="