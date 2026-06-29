# FFmpeg 自编译指南：启用 ddagrab（Desktop Duplication API）

## 背景

### 为什么需要自编译

CoWatch 是游戏复盘录屏平台，**零性能损耗是硬性要求**：

| 捕获方案 | CPU 开销 | 游戏影响 | 可用性 |
|---------|:--------:|:--------:|:------:|
| gdigrab（当前） | 15-25% 单核 | **明显卡顿** ❌ | 窗口模式异常 |
| **ddagrab（目标）** | **≈0%** | **无感知** ✅ | 窗口/整屏均正常 |

- `ffmpeg-static`（npm 包）和 gyan.dev / BtbN 预构建版本都**禁用了 ddagrab**
- 原因：ddagrab 需要链接系统 DLL（d3d11.dll、dxgi.dll），违反"零依赖静态构建"原则
- **唯一途径**：从源码编译，手动开启 `--enable-ddagrab`

### 当前代码已就绪

[recorder.ts](../electron/handlers/recorder.ts) 已改为 ddagrab 参数：

```typescript
// 整屏
inputArgs = ['-f', 'ddagrab', '-framerate', '30', '-i', '0'];

// 窗口（自动跟踪移动）
inputArgs = ['-f', 'ddagrab', '-framerate', '30', '-window_title', safeTitle, '-i', '0'];
```

**只需要把 ffmpeg.exe 换成带 ddagrab 的版本即可。**

---

## 编译环境准备

### 第一步：安装 MSYS2

MSYS2 是 Windows 下编译 FFmpeg 的标准环境（提供 Unix-like shell + 工具链）。

1. 访问 https://www.msys2.org/
2. 下载 `msys2-x86_64-*.exe`（约 80MB）
3. 安装到默认路径 `C:\msys64`
4. 安装完成后**先不要关闭终端**，按提示输入 `exit` 关闭后重新打开 MSYS2 终端

5. 更新系统包：
   ```bash
   pacman -Syu
   ```
   如果提示重启 MSYS2，就关掉重开再跑一次 `pacman -Su` 直到无更新

### 第二步：安装编译依赖

在 MSYS2 终端中执行：

```bash
# 基础工具
pacman -S base-devel git yasm nasm pkg-config diffutils

# Windows SDK 相关（DDA API 需要）
pacman -S mingw-w64-x86_64-toolchain mingw-w64-x86_64-dlfcn

# FFmpeg 可选依赖（根据需要选择）
pacman -S mingw-w64-x86_64-freetype    # 字幕渲染
pacman -S mingw-w64-x86_64-libass      # ASS 字幕
pacman -S mingw-w64-x86_64-libvpx      # VP8/VP9 编解码
pacman -S mingw-w64-x86_64-libvorbis   # Vorbis 音频
pacman -S mingw-w64-x86_64-libmp3lame  # MP3 编码
```

> **注意**：每条命令会列出要安装的包，确认后输入 `y` 回车即可。

### 第三步：安装 Visual Studio Build Tools（关键）

FFmpeg 的 DDA/DD3D11 功能需要 Windows SDK 头文件：

1. 访问 https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. 下载 Build Tools for Visual Studio 2022
3. 安装时勾选：
   - ✅ **使用 C++ 的桌面开发**
   - ✅ **Windows 10/11 SDK**（最新版）
4. 安装完成后**重启电脑**

---

## 编译 FFmpeg

### 第四步：获取源码

```bash
cd ~
git clone https://github.com/FFmpeg/FFmpeg.git ffmpeg-src
cd ffmpeg-src

# 切换到稳定版（推荐 7.0 或 7.1，避免 master 可能的不稳定）
git checkout n7.0
# 或者 git checkout n7.1
```

### 第五步：配置（configure）

这是最关键的一步——开启 ddagrab 和硬件编码器：

```bash
./configure \
  --prefix=/home/YourUser/ffmpeg-build \
  --arch=x86_64 \
  --target-os=mingw64 \
  --toolchain=mingw64 \
  --enable-gpl \
  --enable-nonfree \
  --enable-shared \
  --disable-static \
  --disable-doc \
  \
  # ===== 核心：启用 ddagrab =====
  --enable-ddagrab \
  --enable-d3d11va \
  \
  # ===== 硬件编码器（三选一或多选）=====
  --enable-nvenc \           # NVIDIA 显卡
  --enable-qsv \             # Intel 核显
  --enable-amf \             # AMD 显卡
  --enable-hwaccel=h264_nvenc \
  --enable-hwaccel=h264_qsv \
  --enable-hwaccel=h264_amf \
  \
  # ===== 编码器和解码器 =====
  --encoder=libx264,libx265,h264_nvenc,h264_qsv,h264_amf,aac \
  --decoder=h264,hevc,aac,mp3 \
  \
  # ===== 其他实用功能 =====
  --enable-libx264 \
  --enable-libx265 \
  --enable-libmp3lame \
  --enable-filter=scale,crop,pad,fps,setpts \
  --enable-protocol=file,http,tcp \
  --enable-muxer=hls,mp4,flv,ts \
  --enable-demuxer=mov,hls,flv,ts \
  \
  # ===== 优化选项 =====
  --extra-cflags="-O3 -march=native" \
  --extra-ldflags="-static"
```

**如果 configure 报错**：
- 找不到 d3d11va → 确认 VS Build Tools 已装且包含 Windows SDK
- 找不到 nvenc/qsv/amf → 对应的显卡驱动未安装或太旧
- 其他错误 → 把完整报错贴给 AI 分析

### 第六步：编译

```bash
make -j$(nproc)
```

- `-j$(nproc)` 使用所有 CPU 核心并行编译
- 预计耗时：**10-30 分钟**（取决于 CPU）
- 如果中途报错，通常是某个依赖缺失，贴给 AI 即可

### 第七步：安装（收集产物）

```bash
make install
```

完成后，产物在 `/home/YourUser/ffmpeg-build/bin/` 目录下：

```
ffmpeg-build/
├── bin/
│   ├── ffmpeg.exe          ← 主程序（这个就是我们要的）
│   ├── ffplay.exe          （可选）
│   ├── ffprobe.exe         （可选）
│   └── *.dll               ← 运行时依赖的 DLL（约 50 个）
├── include/
├── lib/
└── share/
```

### 第八步：验证 ddagrab 是否可用

```bash
cd ~/ffmpeg-build/bin
./ffmpeg.exe -formats 2>&1 | grep ddagrab
```

**预期输出**：
```
 D  ddagrab        Desktop Duplication API screen capture for Windows
```

如果有这行，说明编译成功！✅

再测试一下实际捕获能力：
```bash
# 测试整屏捕获 5 秒
./ffmpeg.exe -f ddagrab -framerate 30 -i 0 -t 5 -y test_output.mp4
```

如果能生成文件且播放有画面，说明完全正常。

---

## 集成到 CoWatch 项目

### 第九步：复制二进制文件

将以下内容复制到 CoWatch 项目：

```
来源：~/ffmpeg-build/bin/
目标：CoWatch/electron/bin/

需要的文件：
├── ffmpeg.exe          ← 必须
└── 所有 .dll 文件       ← 必须（运行时依赖）
```

### 第十步：修改代码

修改 [recorder.ts](../electron/handlers/recorder.ts) 中的 `getFfmpegPath()` 函数：

```typescript
function getFfmpegPath(): string {
  if (app.isPackaged) {
    // packaged 模式：优先用内嵌的带 ddagrab 版本
    const bundledPath = path.join(
      process.resourcesPath || app.getAppPath(),
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    );
    if (fs.existsSync(bundledPath)) return bundledPath;
    
    // fallback 到 ffmpeg-static（macOS/Linux）
    return ffmpegPath;
  }
  
  // dev 模式：优先找项目内 electron/bin/
  const localBinPath = path.join(__dirname, '..', 'bin', 
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localBinPath)) return localBinPath;
  
  // 最终 fallback
  return ffmpegPath;
}
```

### 第十一步：配置 electron-builder 打包

修改 [electron-builder.yml](../electron-builder.yml)，添加 extraResources：

```yaml
extraResources:
  - from: "electron/bin/"
    to: "bin/"
    filter:
      - "**/*"
```

这样打包时会把 `electron/bin/` 下的所有文件（ffmpeg.exe + DLL）一起打进安装包。

### 第十二步：测试

```bash
npm run electron:pack:test
```

安装运行后测试：
1. ✅ 选整屏录制 Endfield → 不卡顿、画面正确
2. ✅ 选窗口录制 Endfield → 不卡顿、画面正确、拖动窗口不丢失
3. ✅ 录制结束弹窗提示正常
4. ✅ 视频播放正常

---

## 常见问题

### Q：编译时报错找不到 d3d11.h
**A**：VS Build Tools 未正确安装或未包含 Windows SDK。重新运行 installer 确认勾选了 "Windows 10/11 SDK"。

### Q：nvenc/qsv/amf 无法启用
**A**：对应显卡驱动太旧或不存在。
- nvenc：NVIDIA 显卡，驱动 ≥ 418.81
- qsv：Intel 核显（6代+），驱动最新版
- amf：AMD 显卡，驱动 ≥ 18.Q3

如果都不存在也没关系——ddagrab 本身解决的是**捕获**性能，编码部分 libx264 在 CPU 占用降低后通常够用。

### Q：编译出来的 exe 太大？
**A**：shared build 的 ffmpeg.exe 本身只有几 MB，但加上 DLL 总共约 50-80 MB。这对 Electron 应用来说完全可以接受（整个应用本身就好几百 MB）。

### Q：以后 FFmpeg 更新怎么办？
**A**：重复第四~七步即可。建议锁定到一个稳定版本号（如 n7.0），避免跟随 master。

### Q：能否自动化这个流程？
**A**：可以写一个 GitHub Actions workflow 自动编译并上传 artifact，但这属于 CI/CD 范畴，后续可考虑。

---

## 参考资源

- [FFmpeg 官方文档 - ddagrab](https://ffmpeg.org/ffmpeg-devices.html#Desktop-Duplication-API)
- [MSYS2 安装指南](https://www.msys2.org/)
- [FFmpeg Windows 编译 Wiki](https://trac.ffmpeg.org/wiki/CompilationGuide/MinGW-64Bit)
- [Desktop Duplication API 微软文档](https://learn.microsoft.com/en-us/windows/win32/direct3ddesktop/dxgi-desktop-duplication)

---