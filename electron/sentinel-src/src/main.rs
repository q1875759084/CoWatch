//! window_sentinel.exe — 窗口关闭哨兵
//!
//! 用法: window_sentinel.exe --title "目标窗口标题"
//!
//! 工作流程:
//!   1. 解析 --title 参数
//!   2. EnumWindows 遍历所有顶层窗口，按标题匹配找到目标 hwnd
//!   3. 若初始找不到 → 输出 "NOT_FOUND" 到 stdout → 退出 (code 2)
//!   4. SetWinEventHook(EVENT_OBJECT_DESTROY) 注册回调
//!   5. 进入 Win32 消息循环 (GetMessage/DispatchMessage)
//!   6. 回调中检查 event hwnd == target hwnd → 输出 "CLOSED" → 退出 (code 0)
//!   7. 录制停止时主进程 kill sentinel → SIGTERM → 进程退出 = 自动 Unhook
//!
//! 输出格式 (stdout, 每行一条):
//!   "NOT_FOUND"  — 启动时找不到目标窗口
//!   "CLOSED"     — 目标窗口已关闭/销毁
//!   "HEARTBEAT"  — 每 30s 一次，表示哨兵仍在运行 (可选，默认关闭)
//!
//! stderr: 日志输出，不影响 stdout 的业务语义

use std::io::{self, Write};
use std::time::Duration;

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetMessageW, PostQuitMessage, TranslateMessage,
    EVENT_OBJECT_DESTROY, HWINEVENTHOOK, MSG, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    SetWinEventHook, UnhookWinEvent,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};

// ─── 全局状态 ────────────────────────────────────────────────────────────────

/// 目标窗口 hwnd，由 EnumWindows 在启动时确定
static mut TARGET_HWND: HWND = HWND(0);

/// 是否已输出 CLOSED（防止重复触发）
static mut CLOSED_SENT: bool = false;

/// WinEvent hook handle，退出时需要 Unhook
static mut EVENT_HOOK: HWINEVENTHOOK = HWINEVENTHOOK(0);

// ─── Win32 回调与辅助函数 ──────────────────────────────────────────────────

/// EnumWindows 回调：遍历所有顶层窗口，匹配标题
extern "system" fn enum_windows_callback(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    // 只关心可见、有标题的顶层窗口
    let mut title_buf = [0u16; 512];
    let len = windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(hwnd, &mut title_buf);
    if len == 0 {
        return TRUE; // 无标题窗口，跳过但继续遍历
    }

    let title = String::from_utf16_lossy(&title_buf[..len as usize]);

    // 检查窗口可见性
    let visible = windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd);
    if !visible.as_bool() {
        return TRUE;
    }

    // 读取启动参数中的目标标题（存储在 lparam 中不可行，使用全局）
    // 目标标题通过 TARGET_TITLE 全局变量传入
    let target_title = unsafe { &*TARGET_TITLE_PTR };

    if title == target_title {
        unsafe {
            TARGET_HWND = hwnd;
        }
        // 找到了，停止遍历 — 返回 FALSE
        return BOOL(0);
    }

    TRUE // 继续遍历
}

/// 目标标题字符串（从命令行参数获取）
static mut TARGET_TITLE_PTR: *const String = 0 as *const String;

/// SetWinEventHook 回调：监听 EVENT_OBJECT_DESTROY
extern "system" fn win_event_callback(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _dw_event_thread: u32,
    _dwms_event_time: u32,
) {
    // 只关心 OBJID_WINDOW 级别的 DESTROY 事件（过滤子控件 destroy）
    if event != EVENT_OBJECT_DESTROY as u32 {
        return;
    }
    if id_object != OBJID_WINDOW as i32 {
        return;
    }

    // hwnd 精确匹配：只响应目标窗口的 destroy
    unsafe {
        if hwnd == TARGET_HWND && !CLOSED_SENT {
            CLOSED_SENT = true;
            output_stdout("CLOSED");
            // Unhook 后退出消息循环
            UnhookWinEvent(EVENT_HOOK);
            PostQuitMessage(0);
        }
    }
}

/// 向 stdout 输出一行文本，确保 flush
fn output_stdout(msg: &str) {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", msg).ok();
    stdout.flush().ok();
}

/// 向 stderr 输出日志
fn log_stderr(msg: &str) {
    let mut stderr = io::stderr().lock();
    writeln!(stderr, "[sentinel] {}", msg).ok();
    stderr.flush().ok();
}

// ─── main ──────────────────────────────────────────────────────────────────

fn main() {
    // 解析命令行参数
    let args: Vec<String> = std::env::args().collect();
    let title = match parse_title_arg(&args) {
        Some(t) => t,
        None => {
            log_stderr("用法: window_sentinel.exe --title \"目标窗口标题\"");
            std::process::exit(1);
        }
    };

    log_stderr(&format!("启动，目标窗口: \"{}\"", title));

    // 将标题存入全局（EnumWindows 回调需要访问）
    // 安全性：main 线程独占，EnumWindows 是同步调用，不存在并发访问
    unsafe {
        TARGET_TITLE_PTR = &title as *const String;
    }

    // ── Step 1: EnumWindows 定位目标 hwnd ────────────────────────────────
    let result = unsafe {
        EnumWindows(Some(enum_windows_callback), LPARAM(0))
    };

    let target_hwnd = unsafe { TARGET_HWND };

    if target_hwnd == HWND(0) {
        // 初始找不到目标窗口 — 可能窗口已被关闭或标题不匹配
        log_stderr("目标窗口未找到");
        output_stdout("NOT_FOUND");
        std::process::exit(2);
    }

    // 验证 hwnd 仍然有效（EnumWindows 到设置全局之间窗口可能已关闭）
    if !windows::Win32::UI::WindowsAndMessaging::IsWindow(target_hwnd).as_bool() {
        log_stderr("目标 hwnd 已失效");
        output_stdout("NOT_FOUND");
        std::process::exit(2);
    }

    // 获取 hwnd 的进程 ID，用于日志
    let mut pid: u32 = 0;
    windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(target_hwnd, Some(&mut pid));
    log_stderr(&format!("目标 hwnd={}, pid={}", target_hwnd.0, pid));

    // ── Step 2: SetWinEventHook ───────────────────────────────────────────
    // WINEVENT_OUTOFCONTEXT: 回调在 sentinel 进程内执行（不注入目标进程）
    // 事件范围: EVENT_OBJECT_DESTROY ~ EVENT_OBJECT_DESTROY（仅监听 destroy）
    // 进程范围: 0 = 所有进程（需要跨进程监听）
    let hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_DESTROY,
            EVENT_OBJECT_DESTROY,
            None, // 无 DLL（OUTOFCONTEXT 模式）
            Some(win_event_callback),
            0,    // 所有进程
            0,    // 所有线程
            WINEVENT_OUTOFCONTEXT,
        )
    };

    if hook.is_invalid() || hook == HWINEVENTHOOK(0) {
        log_stderr("SetWinEventHook 失败");
        std::process::exit(3);
    }

    unsafe {
        EVENT_HOOK = hook;
    }

    log_stderr("SetWinEventHook 注册成功，进入消息循环");

    // ── Step 3: Win32 消息循环 ───────────────────────────────────────────
    // SetWinEventHook WINEVENT_OUTOFCONTEXT 模式要求调用线程有消息循环
    // GetMessageW 会阻塞直到收到消息，PostQuitMessage(0) 会终止循环
    let mut msg = MSG::default();
    loop {
        let ret = unsafe { GetMessageW(&mut msg, HWND(0), 0, 0) };
        if ret.0 == 0 {
            // WM_QUIT — PostQuitMessage 触发，正常退出
            break;
        }
        if ret.0 == -1 {
            // GetMessage 错误 — 理论上不应发生
            log_stderr("GetMessageW 返回错误");
            break;
        }
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    // ── Step 4: 清理 ─────────────────────────────────────────────────────
    // 确保 CLOSED 已输出（若尚未输出，可能是 PostQuitMessage 后进程被 kill）
    unsafe {
        if !CLOSED_SENT {
            // 消息循环退出但窗口未关闭 — 可能是被主进程 SIGTERM
            // 不输出 CLOSED，避免误报
            log_stderr("消息循环退出，未检测到窗口关闭（可能被主进程终止）");
        }
        // UnhookWinEvent 已在回调中执行，此处做安全兜底
        if EVENT_HOOK != HWINEVENTHOOK(0) {
            UnhookWinEvent(EVENT_HOOK);
        }
    }

    // 给 stdout 100ms 确保 flush 完成（Windows 进程退出时管道可能来不及 drain）
    std::thread::sleep(Duration::from_millis(100));

    log_stderr("退出 (code 0)");
}

/// 解析 --title 命令行参数
fn parse_title_arg(args: &[String]) -> Option<String> {
    let mut i = 1; // 跳过 args[0]（程序名）
    while i < args.len() {
        if args[i] == "--title" && i + 1 < args.len() {
            return Some(args[i + 1].clone());
        }
        i += 1;
    }
    None
}
