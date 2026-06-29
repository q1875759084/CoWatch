# FFmpeg 自编译指南：启用 ddagrab（Desktop Duplication API）

> **必须在 MSYS2 MinGW64 终端里操作**（开始菜单找 "MSYS2 MinGW x64"，不是 "MSYS2 MSYS"，用错终端会导致工具链混用报错）

---

## 第一步：安装 MSYS2

1. 访问 https://www.msys2.org/，下载 `msys2-x86_64-*.exe`（约 80MB）
2. 安装到默认路径 `C:\msys64`
3. 安装完成后打开 **MSYS2 MinGW x64** 终端，更新系统包：

```bash
pacman -Syu
```

如果提示重启 MSYS2，关掉重开再跑一次 `pacman -Su`，直到无更新。

---

## 第二步：安装编译依赖

在 **MSYS2 MinGW x64** 终端中执行：

```bash
pacman -S base-devel git yasm nasm pkg-config diffutils
pacman -S mingw-w64-x86_64-toolchain mingw-w64-x86_64-dlfcn
pacman -S mingw-w64-x86_64-libx264
```

> MSYS2 的 mingw-w64 工具链自带 d3d11 头文件，通常不需要安装 VS Build Tools。如果 configure 报找不到 `d3d11.h`，再按下方说明安装。

<details>
<summary>备用：VS Build Tools 安装方法（configure 报错 d3d11.h 时再装）</summary>

1. 访问 https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. 下载 Build Tools for Visual Studio 2022
3. 安装时勾选：使用 C++ 的桌面开发 + Windows 10/11 SDK（最新版）
4. 安装完成后重启电脑

</details>

---

## 第三步：获取 FFmpeg 源码

```bash
cd ~
git clone https://github.com/FFmpeg/FFmpeg.git ffmpeg-src
cd ffmpeg-src
git checkout n7.1
```

---

## 第四步：配置（configure）

> **路径里不要有空格**，否则 make install 会失败。

```bash
./configure \
  --prefix=/home/$(whoami)/ffmpeg-build \
  --arch=x86_64 \
  --target-os=mingw64 \
  --toolchain=mingw64 \
  --enable-gpl \
  --enable-nonfree \
  --enable-shared \
  --disable-static \
  --disable-doc \
  --enable-ddagrab \
  --enable-d3d11va \
  --enable-libx264 \
  --enable-encoder=libx264 \
  --enable-encoder=h264_nvenc \
  --enable-encoder=h264_qsv \
  --enable-encoder=h264_amf \
  --enable-decoder=h264 \
  --enable-muxer=hls \
  --enable-muxer=mpegts \
  --enable-demuxer=mov \
  --enable-filter=scale \
  --enable-filter=fps \
  --enable-protocol=file \
  --enable-protocol=http \
  --enable-protocol=tcp
```

**configure 常见报错处理：**

| 报错 | 原因 | 解决 |
|------|------|------|
| `d3d11.h: No such file` | mingw-w64 headers 缺失 | `pacman -S mingw-w64-x86_64-headers-extra` 或安装 VS Build Tools |
| `ERROR: libx264 not found` | libx264 未安装 | `pacman -S mingw-w64-x86_64-libx264` |
| `nasm/yasm not found` | 汇编器缺失 | `pacman -S nasm yasm` |
| nvenc/qsv/amf 报错 | 对应显卡驱动未安装或太旧 | 跳过对应 `--enable-encoder` 行即可，不影响 ddagrab |

---

## 第五步：编译

```bash
make -j$(nproc)
```

预计耗时 10~30 分钟（取决于 CPU）。

---

## 第六步：安装（收集产物）

```bash
make install
```

产物在 `/home/$(whoami)/ffmpeg-build/bin/`：

```
ffmpeg-build/bin/
├── ffmpeg.exe          ← 主程序
├── ffplay.exe          （可选）
├── ffprobe.exe         （可选）
└── *.dll               ← 运行时依赖（约 10 个 avcodec*.dll / avformat*.dll 等）
```

> d3d11.dll / dxgi.dll 是 Windows 系统组件，**不需要**随包分发。

---

## 第七步：验证 ddagrab 是否可用

```bash
cd ~/ffmpeg-build/bin
./ffmpeg.exe -formats 2>&1 | grep ddagrab
```

预期输出：
```
 D  ddagrab        Desktop Duplication API screen capture for Windows
```

测试实际捕获（整屏 5 秒）：
```bash
./ffmpeg.exe -f ddagrab -framerate 30 -i 0 -t 5 -y test_output.mp4
```

能生成文件且播放有画面即为成功。

---

## 第八步：集成到 CoWatch

### 复制二进制文件

```
来源：~/ffmpeg-build/bin/
目标：CoWatch/electron/bin/

需要的文件：
├── ffmpeg.exe        ← 必须
└── 所有 .dll 文件    ← 必须（运行时依赖，约 10 个）
```

### 修改 `getFfmpegPath()`

修改 `electron/handlers/recorder.ts` 中的 `getFfmpegPath()` 函数，优先读取项目内的自编译版本：

```typescript
function getFfmpegPath(): string {
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  if (app.isPackaged) {
    // packaged 模式：优先用内嵌的带 ddagrab 版本（extraResources 打包）
    const bundledPath = path.join(process.resourcesPath, 'bin', binName);
    if (fs.existsSync(bundledPath)) return bundledPath;
    // fallback 到 ffmpeg-static（macOS/Linux）
    return ffmpegPath as string;
  }

  // dev 模式：优先找项目内 electron/bin/
  const localBinPath = path.join(__dirname, '..', 'bin', binName);
  if (fs.existsSync(localBinPath)) return localBinPath;

  // 最终 fallback（ffmpeg-static，macOS/Linux 或 Windows 未放自编译版时）
  return ffmpegPath as string;
}
```

### 配置 electron-builder 打包

在 `electron-builder.yml` 中添加 `extraResources`，将 `electron/bin/` 打进安装包：

```yaml
extraResources:
  - from: "electron/bin/"
    to: "bin/"
    filter:
      - "**/*"
```

---

## 参考资源

- [FFmpeg 官方文档 - ddagrab](https://ffmpeg.org/ffmpeg-devices.html#Desktop-Duplication-API)
- [FFmpeg Windows 编译 Wiki（官方）](https://trac.ffmpeg.org/wiki/CompilationGuide/MinGW-64Bit)
- [MSYS2 官网](https://www.msys2.org/)
- [Desktop Duplication API 微软文档](https://learn.microsoft.com/en-us/windows/win32/direct3ddesktop/dxgi-desktop-duplication)
