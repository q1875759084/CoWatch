# window_sentinel.exe 编译指南

## 前置条件

1. 安装 Rust 工具链：
   ```bash
   # 安装 rustup（Rust 版本管理器）
   # Windows: 从 https://rustup.rs 下载并运行 rustup-init.exe
   # 或使用 winget:
   winget install Rustlang.Rustup

   # 安装 MSVC 工具链（Rust on Windows 默认使用 MSVC ABI）
   # 需要 Visual Studio Build Tools 2019+ 或 Visual Studio 2019+（C++ 工具集）
   # 如已安装 Visual Studio，无需额外操作
   ```

2. 验证安装：
   ```bash
   rustc --version     # 应输出 1.70+ 版本
   cargo --version     # 应输出对应版本
   ```

## 编译步骤

```bash
# 进入源码目录
cd electron/sentinel-src

# 编译 Release 版本（最小体积 + 剽弃调试符号）
cargo build --release --target x86_64-pc-windows-msvc

# 编译产物位于：
#   target/x86_64-pc-windows-msvc/release/window_sentinel.exe
#   大约 ~200KB（Rust runtime + windows-rs 绑定）
```

## 安装到 CoWatch

```bash
# 将编译好的 exe 复制到 electron/bin/ 目录
cp target/x86_64-pc-windows-msvc/release/window_sentinel.exe ../bin/window_sentinel.exe

# 验证
ls -la ../bin/window_sentinel.exe
```

## 打包配置（electron-builder.yml 已配置）

`electron-builder.yml` 的 `extraResources` 已包含 `bin/*` 通配符，
`window_sentinel.exe` 放入 `electron/bin/` 后会自动被打包到 `resources/bin/`。

无需额外修改打包配置。

## 快速验证（手动测试）

```bash
# 启动一个记事本窗口
notepad.exe

# 运行 sentinel 监听记事本
./electron/bin/window_sentinel.exe --title "无标题 - 记事本"

# 关闭记事本窗口 → sentinel 应输出 "CLOSED" 并退出 (code 0)
# 预期输出：
#   stdout: CLOSED
#   stderr: [sentinel] 启动，目标窗口: "无标题 - 记事本"
#   stderr: [sentinel] 目标 hwnd=..., pid=...
#   stderr: [sentinel] SetWinEventHook 注册成功，进入消息循环
#   stderr: [sentinel] 退出 (code 0)
```

## 未来 Arm64 支持

```bash
# 安装 Arm64 目标
rustup target add aarch64-pc-windows-msvc

# 编译 Arm64 版本（需要 Arm64 MSVC linker，目前 Visual Studio 2022 17.4+ 支持）
cargo build --release --target aarch64-pc-windows-msvc
```

## 交叉编译（macOS 开发机上编译 Windows exe）

需要安装 `x86_64-pc-windows-msvc` 目标，但 MSVC linker 在 macOS 上不可用。
推荐替代方案：

1. 在 Windows 上编译一次，将 exe 提交到仓库
2. 使用 GitHub Actions CI 编译（推荐）
3. 使用 `x86_64-pc-windows-gnu` 目标（MinGW linker，macOS 可用，但 ABI 与 MSVC 不同）

## CI 编译（GitHub Actions 示例）

```yaml
name: Build window_sentinel
on: [push]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --release --target x86_64-pc-windows-msvc
        working-directory: electron/sentinel-src
      - uses: actions/upload-artifact@v4
        with:
          name: window_sentinel
          path: electron/sentinel-src/target/x86_64-pc-windows-msvc/release/window_sentinel.exe
```
