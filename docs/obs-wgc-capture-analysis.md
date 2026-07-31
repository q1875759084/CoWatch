# OBS WGC 窗口捕获源码分析

> 目的：为后续 AI 提供 OBS WGC 捕获实现的完整地图，用于评估/实施独立 window_capture.exe 方案。
> 基于源码版本：obs-studio（c:\Users\绝绝子\Desktop\Co\obs-studio）

---

## 一、核心架构

### 1.1 整体数据流

```
WGC 回调线程（COM STA）：
  DWM 合成新帧 → on_frame_arrived() → CopySubresourceRegion 到 gs_texture

OBS 渲染线程（固定33ms）：
  video_tick() → 检查窗口状态
  video_render() → winrt_capture_render() → 读取 gs_texture → 送入编码器
```

**关键点：捕获和渲染完全解耦。** WGC 回调只负责"把最新帧拷到纹理"，渲染线程按自己的节奏读纹理。即使 WGC 回调慢，渲染线程仍每33ms输出一帧（复用上一帧）。

### 1.2 与 FFmpeg gfxcapture 的根本差异

| 维度 | OBS | FFmpeg gfxcapture |
|------|-----|-------------------|
| 架构 | 双线程解耦（回调线程 + 渲染线程） | 单线程同步（request_frame 阻塞等回调） |
| 帧获取 | 回调异步写纹理，渲染时读最新 | request_frame 同步等 WGC 递帧 |
| 无新帧时 | 渲染线程复用上一帧（texture_written 检查） | 阻塞等待或返回空（由 -vsync cfr 补帧） |
| 帧率稳定性 | 渲染线程控制，稳定30/60fps | WGC 递帧节奏决定，不稳定 |
| GPU 上下文 | OBS 自有 D3D11 device + gs_texture | FFmpeg lavfi 内部 hwframe |

**这就是 OBS 稳定而 gfxcapture 不稳定的根本原因。**

---

## 二、关键文件清单

### 2.1 核心文件（必须移植）

| 文件 | 行数 | 职责 | 移植难度 |
|------|------|------|---------|
| `libobs-winrt/winrt-capture.cpp` | ~600 | WGC 核心：初始化、回调、帧拷贝 | **高**（依赖 libobs graphics） |
| `libobs-winrt/winrt-capture.h` | ~30 | 接口定义 | 低 |
| `libobs-winrt/winrt-dispatch.cpp` | ~60 | WinRT 公寓初始化 + DispatcherQueue | 中 |
| `libobs-winrt/winrt-dispatch.h` | ~20 | 接口定义 | 低 |
| `libobs-winrt/CMakeLists.txt` | ~35 | 编译配置 + 依赖声明 | 参考 |

### 2.2 调用方文件（参考逻辑）

| 文件 | 行数 | 职责 |
|------|------|------|
| `plugins/win-capture/window-capture.c` | ~845 | 窗口捕获插件：窗口查找、方法选择(WGC/BitBlt)、tick/render 循环 |

### 2.3 libobs 依赖（需剥离或替代）

OBS 的 WGC 代码深度依赖 libobs 的 graphics 抽象层：

| 依赖 | 用途 | 剥离方案 |
|------|------|---------|
| `gs_texture_t` | 存储捕获的帧 | 替换为原生 `ID3D11Texture2D` |
| `gs_get_device_obj()` | 获取 D3D11 device | 自己创建 D3D11 device |
| `obs_enter_graphics()` | graphics 上下文锁 | 直接用 CriticalSection |
| `gs_register_loss_callbacks()` | 设备丢失回调 | 自己实现设备丢失处理 |
| `blog()` | 日志 | 替换为 printf/stderr |

---

## 三、winrt-capture.cpp 核心逻辑详解

### 3.1 数据结构（第94-120行）

```cpp
struct winrt_capture {
    HWND window;                    // 目标窗口
    BOOL client_area;               // 是否只捕获客户区
    DXGI_FORMAT format;             // 像素格式（SDR/HDR）
    bool capture_cursor;
    BOOL cursor_visible;

    gs_texture_t *texture;          // ← libobs 依赖，需替换为 ID3D11Texture2D
    bool texture_written;           // 关键标志：是否有新帧写入

    GraphicsCaptureItem item;       // WGC 捕获目标
    IDirect3DDevice device;         // WinRT D3D device
    ComPtr<ID3D11DeviceContext> context;  // D3D11 上下文
    Direct3D11CaptureFramePool frame_pool;  // 帧池
    GraphicsCaptureSession session;  // WGC 会话

    SizeInt32 last_size;            // 上次帧尺寸（检测窗口缩放）
    Closed_revoker closed;          // 窗口关闭事件
    FrameArrived_revoker frame_arrived;  // 帧到达事件

    uint32_t texture_width, texture_height;
    D3D11_BOX client_box;           // 客户区裁剪框
    BOOL active;
};
```

### 3.2 初始化流程（winrt_capture_init_internal，第345-432行）

```
1. 从 gs_get_device_obj() 获取 D3D11 device  ← 需替换为自己创建
2. QueryInterface → IDXGIDevice
3. CreateDirect3D11DeviceFromDXGIDevice → WinRT IDirect3DDevice
4. winrt::get_activation_factory<GraphicsCaptureItem>()
   → IGraphicsCaptureItemInterop
5. interop_factory->CreateForWindow(window, ...) → GraphicsCaptureItem
6. item.Size() → 初始尺寸
7. Direct3D11CaptureFramePool::Create(device, format, 2, size)
   → frame_pool（帧池大小=2）
8. frame_pool.CreateCaptureSession(item) → session
9. session.IsBorderRequired(false)  ← 去掉黄色边框
10. session.IsCursorCaptureEnabled(cursor)  ← 光标控制
11. item.Closed(回调) → closed 事件
12. frame_pool.FrameArrived(回调) → frame_arrived 事件
13. session.StartCapture()
14. active = TRUE
```

**关键参数**：
- 帧池大小 = 2（`Direct3D11CaptureFramePool::Create` 第3个参数）
- 像素格式：SDR 用 `DXGI_FORMAT_B8G8R8A8_UNORM`，HDR 用 `DXGI_FORMAT_R16G16B16A16_FLOAT`

### 3.3 帧到达回调（on_frame_arrived，第128-195行）

```cpp
void on_frame_arrived(sender, args) {
    frame = sender.TryGetNextFrame();        // 非阻塞获取
    frame_surface = GetDXGIInterfaceFromObject<ID3D11Texture2D>(frame.Surface());
    frame_surface->GetDesc(&desc);           // 获取实际尺寸和格式

    obs_enter_graphics();                    // ← 需替换为 CriticalSection

    if (desc.Format == expected_format) {
        if (client_area) {
            get_client_box(window, ...);     // 计算客户区裁剪框
            texture_width = client_box.right - client_box.left;
            texture_height = client_box.bottom - client_box.top;
        } else {
            texture_width = desc.Width;
            texture_height = desc.Height;
        }

        // 尺寸变化时重建纹理
        if (texture && size_changed) {
            gs_texture_destroy(texture);
            texture = nullptr;
        }
        if (!texture) {
            texture = gs_texture_create(w, h, format, 1, NULL, 0);
        }

        // 拷贝帧到纹理
        if (client_area) {
            context->CopySubresourceRegion(texture, 0,0,0,0, frame_surface, 0, &client_box);
        } else {
            context->CopyResource(texture, frame_surface);
        }

        texture_written = true;              // ← 关键：标记有新帧
    }

    // 检测尺寸变化，重建帧池
    if (content_size != last_size) {
        frame_pool.Recreate(device, format, 2, content_size);
        last_size = content_size;
    }

    obs_leave_graphics();
}
```

**关键点**：
- `TryGetNextFrame()` 是**非阻塞**的，没有帧时返回 nullptr（但回调本身意味着有帧）
- 拷贝是 GPU 内的 `CopySubresourceRegion`/`CopyResource`，零 CPU 参与
- `texture_written` 标志让渲染线程知道是否有新帧

### 3.4 渲染函数（winrt_capture_render，第528-577行）

```cpp
void winrt_capture_render(capture) {
    if (capture->texture_written) {          // ← 有新帧才渲染
        // ... OBS 特定的 effect/technique 渲染逻辑
        gs_draw_sprite(texture, 0, 0, 0);
    }
    // 如果 texture_written == false，什么都不做
    // → OBS 渲染管线自然复用上一帧
}
```

**这就是 OBS 稳定的核心**：渲染时只检查 `texture_written` 标志，有新帧就画，没有就跳过（OBS 的 video_output 层会自动复用上一帧）。

### 3.5 客户区裁剪（get_client_box，第39-77行）

```cpp
bool get_client_box(window, width, height, client_box) {
    // 检查窗口未最小化（检查两次防 ABA）
    if (IsIconic(window)) return false;

    GetClientRect(window, &client_rect);
    DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &window_rect, ...);
    ClientToScreen(window, &upper_left);

    // 计算客户区在窗口帧中的偏移
    client_box->left = upper_left.x - window_rect.left;
    client_box->top = upper_left.y - window_rect.top;
    client_box->right = left + min(width - left, client_rect.right);
    client_box->bottom = top + min(height - top, client_rect.bottom);

    return (client_box->right <= width) && (client_box->bottom <= height);
}
```

**用途**：WGC 捕获的是整个窗口（含标题栏/边框），`client_area=true` 时只取客户区。CoWatch 不需要这个功能（游戏窗口通常无标题栏），可简化。

### 3.6 窗口关闭处理（on_closed，第122-126行）

```cpp
void on_closed(item, args) {
    active = FALSE;  // 渲染线程检测到后释放资源
}
```

---

## 四、window-capture.c 调用逻辑

### 4.1 方法选择（choose_method，第138-167行）

OBS 支持三种方法：AUTO / BitBlt / WGC。AUTO 根据窗口类名选择：

- **强制 WGC 的类名**：Chrome、Mozilla（部分匹配）；ApplicationFrameWindow、SDL_app 等（完整匹配）
- **其他窗口默认 BitBlt**

**CoWatch 可直接强制 WGC**，不需要方法选择逻辑。

### 4.2 tick 循环（wc_tick，第589-773行）

每帧调用（~33ms）：
1. 检查窗口是否存在（`IsWindow`）
2. 检查窗口是否最小化（`IsIconic`）→ 最小化时跳过
3. 检查光标可见性（前台进程 != 目标进程时隐藏光标）
4. WGC 方法：如果 `capture_winrt == NULL`，调用 `winrt_capture_init_window`
5. 不做帧获取——帧获取在回调中异步完成

### 4.3 render 循环（wc_render，第775-796行）

每帧调用（~33ms）：
1. 检查 `window_normal`（窗口存在且未最小化）
2. WGC 方法：检查 `winrt_capture_active`
3. 调用 `winrt_capture_render` → 内部检查 `texture_written`

---

## 五、编译依赖

### 5.1 CMakeLists.txt 声明的依赖

```cmake
target_link_libraries(libobs-winrt PRIVATE
    OBS::libobs        # ← 需剥离
    OBS::COMutils      # ComPtr（可用 WRL 替代）
    Dwmapi             # DwmGetWindowAttribute
    windowsapp         # WinRT API
)

target_precompile_headers(libobs-winrt PRIVATE
    <d3d11.h>
    <DispatcherQueue.h>
    <dwmapi.h>
    <obs-module.h>     # ← 需剥离
    <util/windows/ComPtr.hpp>  # ← 需替换
    <Windows.Graphics.Capture.Interop.h>
    <windows.graphics.directx.direct3d11.interop.h>
    <winrt/Windows.Foundation.Metadata.h>
    <winrt/Windows.Graphics.Capture.h>
    <winrt/Windows.System.h>
)
```

### 5.2 移植到独立 .exe 需要的 SDK

| SDK/库 | 用途 | 获取方式 |
|--------|------|---------|
| Windows SDK 10.0.19041+ | D3D11、DXGI、WinRT 头文件 | VS Installer |
| C++/WinRT (`cppwinrt`) | WinRT C++ 投影 | NuGet `Microsoft.Windows.CppWinRT` |
| DispatcherQueue.h | WinRT 调度队列 | Windows SDK |
| windowsapp.lib | WinRT 运行时 | Windows SDK |
| dwmtapi.lib | DWM API | Windows SDK |

**不需要**：libobs、FFmpeg、任何第三方库。

### 5.3 移植时需要替换的 libobs 依赖

| libobs API | 替换方案 |
|-----------|---------|
| `gs_get_device_obj()` | 自己 `D3D11CreateDevice` |
| `gs_texture_create/destroy` | `ID3D11Texture2D` 的 Create/Release |
| `gs_texture_get_obj` | 直接用 `ID3D11Texture2D*` |
| `gs_texture_get_width/height` | `ID3D11Texture2D::GetDesc` |
| `obs_enter_graphics/obs_leave_graphics` | `CRITICAL_SECTION` |
| `gs_register_loss_callbacks` | 自己处理 `DXGI_ERROR_DEVICE_REMOVED` |
| `blog()` | `fprintf(stderr, ...)` |
| `ComPtr` | `Microsoft::WRL::ComPtr` 或 `winrt::com_ptr` |

---

## 六、独立 window_capture.exe 设计建议

### 6.1 产物规格

```
window_capture.exe
  输入：命令行参数 --window <title> [--framerate 30] [--cursor] [--no-border]
  输出：stdout rawvideo 流（BGRA）
  stderr：日志和状态行

  协议：
    启动时 stderr 输出 "READY <width> <height>"
    每帧 stdout 写入 width×height×4 字节 BGRA 数据
    窗口关闭时 stderr 输出 "CLOSED"，退出
    窗口最小化时 stderr 输出 "PAUSED"，继续输出去最后一帧（冻结）
    窗口恢复时 stderr 输出 "RESUMED <width> <height>"
```

### 6.2 内部架构

```
主线程（WinRT STA）：
  1. winrt::init_apartment(multi_threaded)
  2. CreateDispatcherQueueController（COM STA）
  3. 创建 D3D11 device
  4. winrt_capture_init_window（注册 WGC 回调）
  5. 进入主循环：
     while (active) {
         // WGC 回调会异步更新 shared_texture
         // 主线程每33ms读取 shared_texture 并写 stdout
         Sleep(33);
         lock(critical_section);
         if (texture_written) {
             // 用 staging texture 拷贝到 CPU 内存
             context->CopyResource(staging, shared_texture);
             context->Map(staging, ...);
             fwrite(staging_data, width*height*4, 1, stdout);
             context->Unmap(staging, 0);
         } else {
             // 冻结帧：重新写入上一帧的数据
             fwrite(last_frame_data, width*height*4, 1, stdout);
         }
         unlock(critical_section);
     }

WGC 回调线程（COM MTA）：
  on_frame_arrived:
     lock(critical_section);
     context->CopyResource(shared_texture, frame_surface);
     texture_written = true;
     unlock(critical_section);
```

### 6.3 关键实现点

1. **D3D11 device 创建**：用 `D3D11CreateDevice` 创建，不需要 swap chain
2. **纹理拷贝到 CPU**：用 staging texture + Map/Unmap（GPU→CPU 读取）
3. **冻结帧**：主线程检测 `texture_written == false` 时写上一帧数据
4. **窗口缩放**：WGC 回调中检测 `content_size != last_size`，重建 frame_pool + 通知主线程
5. **窗口关闭**：`on_closed` 回调设置 `active = false`，主线程退出循环
6. **窗口最小化**：主循环检测 `IsIconic(window)`，输出冻结帧

### 6.4 与 FFmpeg 的集成

```
FFmpeg 命令：
  ffmpeg -f rawvideo -pix_fmt bgra -s <W>x<H> -r 30 -i pipe:0
         -c:v h264_nvenc ... -f hls ...

Node spawn：
  const proc = spawn('window_capture.exe', ['--window', title]);
  proc.stdout.pipe(ffmpegProc.stdin);
```

**注意**：rawvideo 管道带宽 = W×H×4×30 bytes/s。1280×720 ≈ 105 MB/s，1920×1080 ≈ 237 MB/s。现代 CPU 内存带宽 >10 GB/s，可接受。

---

## 七、工作量估算

| 任务 | 时间 | 说明 |
|------|------|------|
| 环境搭建（VS + Windows SDK + cppwinrt） | 0.5天 | 一次性 |
| 剥离 libobs 依赖（gs_texture → ID3D11Texture2D） | 1天 | 机械替换 |
| 实现主循环（33ms 定时器 + stdout 输出） | 1天 | 参考 audio_capture.exe 模式 |
| staging texture 拷贝（GPU→CPU） | 0.5天 | D3D11 标准模式 |
| 冻结帧逻辑 | 0.5天 | texture_written 检查 |
| 窗口缩放/最小化/关闭处理 | 1天 | 参考 window-capture.c |
| 与 FFmpeg rawvideo 管道集成 | 0.5天 | 修改 recording/index.ts |
| 编译调试 | 2-3天 | WinRT 回调时序问题 |
| 端到端测试 | 1天 | 验证30fps稳定 |
| **总计** | **8-10天** | |

---

## 八、关键风险

### 8.1 WinRT 公寓模型

WGC 的 `FrameArrived` 回调要求在 STA（Single-Threaded Apartment）中注册。OBS 用 `CreateDispatcherQueueController` 创建 STA 线程。独立 .exe 也必须这样做，否则回调不触发。

**参考**：`winrt-dispatch.cpp` 的 `CreateDispatcherQueueController`。

### 8.2 D3D11 设备丢失

GPU 切换/驱动更新时 D3D11 device 可能丢失。OBS 通过 `gs_register_loss_callbacks` 处理。独立 .exe 需要自己检测 `DXGI_ERROR_DEVICE_REMOVED` 并重建 device + frame_pool。

**简化方案**：检测到设备丢失直接退出，由 Node 层重启进程。

### 8.3 管道缓冲阻塞

stdout 写入可能因 FFmpeg 读取慢而阻塞（管道缓冲区通常 64KB）。需要：
- 用 `setvbuf(stdout, NULL, _IONBF, 0)` 禁用缓冲
- 或用二进制模式 + 手动分块写入

### 8.4 帧率同步

主循环用 `Sleep(33)` 粗略定时，实际精度受 Windows 调度器影响（~15ms）。可选：
- `timeBeginPeriod(1)` 提升定时器精度
- 或用 multimedia timer（`timeSetEvent`）

---

## 九、与 CoWatch 现有架构的集成

### 9.1 替换 gfxcapture

```typescript
// recording/index.ts 改动
if (currentSourceId.startsWith('window:')) {
  // 旧：gfxcapture lavfi
  // inputArgs = ['-f', 'lavfi', '-i', `gfxcapture=...`];

  // 新：window_capture.exe + rawvideo pipe
  inputArgs = ['-f', 'rawvideo', '-pix_fmt', 'bgra',
               '-s', `${width}x${height}`, '-r', '30', '-i', 'pipe:0'];
  // spawn window_capture.exe，stdout → ffmpeg stdin
}
```

### 9.2 与 sentinel 的关系

- **sentinel**：监听窗口位置/最小化/前台切换 → 通知 Node 层
- **window_capture.exe**：自己处理窗口关闭/最小化（内部检测）

两者职责重叠。可选：
- **方案1**：window_capture.exe 自包含，不需要 sentinel（简化）
- **方案2**：sentinel 负责窗口位置（全屏 ddagrab+crop 用），window_capture.exe 负责窗口捕获（窗口录制用）

**推荐方案1**：窗口录制完全由 window_capture.exe 处理，sentinel 只用于全屏 ddagrab+crop 场景（如果需要）。

### 9.3 Linux

- Linux：用 PipeWire（类似 WGC 的推模式，但 Linux 不是 CoWatch 目标平台）

---

## 十、结论

OBS 的 WGC 实现**逻辑清晰、代码量小（~600行核心）、依赖明确**。移植到独立 .exe 的主要工作是：

1. **剥离 libobs graphics 依赖**（gs_texture → ID3D11Texture2D）
2. **添加 stdout rawvideo 输出**（staging texture + Map/Unmap）
3. **实现主循环 + 冻结帧逻辑**

**预计工作量 8-10 天**，主要风险在 WinRT 公寓模型和回调时序调试。

这是**根治 gfxcapture 不稳定问题的正确方案**——用 OBS 验证过的 WGC 集成姿势，替代 FFmpeg 有缺陷的 gfxcapture 实现。
