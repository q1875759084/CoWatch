#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""window_sentinel — CoWatch 窗口哨兵（Python + ctypes 实现）

通过 Win32 API 监听目标窗口的生命周期事件，向 stdout 输出行协议，
供 sentinel-client.ts 解析（协议语言无关，与历史 Rust 版 100% 兼容）。

stdout 行协议：
  RECT <x> <y> <w> <h>      启动首行，物理像素、主屏相对（output_idx 固定 0）
  PAUSE MINIMIZED            最小化 → 暂停录制（pauseRecording）
  PAUSE FOREGROUND_LOST      失去前台（alt+tab 等）→ 暂停录制
  RESUME                     恢复前台 / 最小化结束 → 恢复录制（resumeRecording）
  STOP MOVED                 前台可见时被移动（去抖确认）→ 结束录制（stop）
  STOP CLOSED                窗口销毁 → 结束录制（stop）
  NOT_FOUND                  未找到目标窗口 → 退出（码 0）

所有协议输出均使用 print(..., flush=True)（并在启动时 reconfigure 行缓冲），
确保 sentinel-client 的 readline 不会因 Python 块缓冲而卡住。
"""

import os
import sys
import ctypes
import threading
from ctypes import wintypes

# ─── Win32 常量 ───────────────────────────────────────────────────────────
PROCESS_PER_MONITOR_DPI_AWARE = 2
DWMWA_EXTENDED_FRAME_BOUNDS = 9
MDT_EFFECTIVE_DPI = 0
MONITOR_DEFAULTTONEAREST = 2

EVENT_SYSTEM_FOREGROUND = 0x0003
EVENT_OBJECT_MINIMIZESTART = 0x0016
EVENT_OBJECT_MINIMIZEEND = 0x0017
EVENT_OBJECT_DESTROY = 0x8001
EVENT_OBJECT_LOCATIONCHANGE = 0x800B

WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002
EVENT_HOOK_FLAGS = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS  # 0x0002

OBJID_WINDOW = 0

MOVE_THRESHOLD_PX = 4          # 与 baseline 差异超过该值才算“移动”
MOVE_CONFIRM_DELAY_S = 0.15    # 事件即时读之后的定时复读间隔

# ─── ctypes 结构与函数原型 ────────────────────────────────────────────────
class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
    ]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wintypes.DWORD),
    ]


user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
shcore = ctypes.windll.shcore
kernel32 = ctypes.windll.kernel32

# EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL

# GetWindowTextW / Length
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

# IsWindowVisible / IsIconic / GetForegroundWindow
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.GetForegroundWindow.argtypes = []
user32.GetForegroundWindow.restype = wintypes.HWND

# MonitorFromWindow / GetMonitorInfoW
user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
user32.MonitorFromWindow.restype = wintypes.HMONITOR
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
user32.GetMonitorInfoW.restype = wintypes.BOOL

# DwmGetWindowAttribute
dwmapi.DwmGetWindowAttribute.argtypes = [
    wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
]
dwmapi.DwmGetWindowAttribute.restype = ctypes.HRESULT

# GetDpiForMonitor
shcore.GetDpiForMonitor.argtypes = [
    wintypes.HMONITOR, ctypes.c_int,
    ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT),
]
shcore.GetDpiForMonitor.restype = ctypes.HRESULT

# SetProcessDpiAwareness / SetProcessDPIAware
shcore.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
shcore.SetProcessDpiAwareness.restype = ctypes.HRESULT
user32.SetProcessDPIAware.argtypes = []
user32.SetProcessDPIAware.restype = wintypes.BOOL

# SetWinEventHook / UnhookWinEvent
WinEventProcType = ctypes.WINFUNCTYPE(
    None,
    wintypes.HANDLE,   # hWinEventHook
    wintypes.DWORD,    # event
    wintypes.HWND,     # hwnd
    wintypes.LONG,     # idObject
    wintypes.LONG,     # idChild
    wintypes.DWORD,    # dwEventThread
    wintypes.DWORD,    # dwmsEventTime
)
user32.SetWinEventHook.argtypes = [
    wintypes.UINT, wintypes.UINT, wintypes.HMODULE, WinEventProcType,
    wintypes.DWORD, wintypes.DWORD, wintypes.UINT,
]
user32.SetWinEventHook.restype = wintypes.HANDLE

# GetMessageW / TranslateMessage / DispatchMessageW / PostQuitMessage
user32.GetMessageW.argtypes = [
    ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
]
user32.GetMessageW.restype = ctypes.c_long
user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
user32.TranslateMessage.restype = wintypes.BOOL
user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
user32.DispatchMessageW.restype = ctypes.c_long
user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.PostQuitMessage.restype = None
# PostThreadMessageW（定时器线程需用它将 WM_QUIT 投递到主消息泵线程）
user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
]
user32.PostThreadMessageW.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.argtypes = []
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

# GetWindowThreadProcessId / GetClassNameW（前台窗口 pid / 类名校验，方案 C 过滤）
user32.GetWindowThreadProcessId.argtypes = [
    wintypes.HWND, ctypes.POINTER(wintypes.DWORD),
]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

# ─── 模块级状态 ──────────────────────────────────────────────────────────
target_hwnd = 0
is_foreground = False
is_minimized = False
should_record = False
baseline_rect = (0, 0, 0, 0)
terminated = False

# 移动去抖状态
move_pending = False
candidate_rect = None
pending_timer = None
state_lock = threading.Lock()

# 前台丢失去抖状态（方案 C：去抖替代立即暂停，避免 CoWatch 自身窗口/IME/Toast 误判）
fg_loss_pending = False
fg_loss_timer = None
# 需忽略前台事件的进程 pid 集合（CLI --ignore-pid 注入，至少覆盖 CoWatch 主进程）
ignore_pids = set()
# 启发式类名过滤（成为前台的非目标窗口命中则视为无关注，不触发暂停）
IGNORE_CLASS_NAMES = {
    'CandidateWindow',             # 中文输入法候选框
    'Windows.UI.Core.CoreWindow',  # UWP / Toast 通知
    'Shell_CharmWindow',           # 系统 Toast / 操作中心
    'Shell_TrayWnd',               # 任务栏
}

# 坐标换算常量（启动后固定；单屏主屏假设）
mon_phys_left = 0.0
mon_phys_top = 0.0
monitor_w = 0.0
monitor_h = 0.0

# 持有 WinEvent 回调引用，防止被 GC
g_win_event_proc = None

# 主消息泵线程 id（用于跨线程投递 WM_QUIT，确保进程干净退出）
main_thread_id = 0
WM_QUIT = 0x0012


def post_quit_to_main() -> None:
    """向主消息泵线程投递 WM_QUIT，使其在 GetMessageW 循环中干净退出。

    定时器回调运行于独立线程，直接调用 PostQuitMessage 会把 WM_QUIT 投到
    定时器线程自身，主泵线程永远收不到 → 进程挂起。故统一经主线程 id 投递。
    """
    if main_thread_id:
        user32.PostThreadMessageW(main_thread_id, WM_QUIT, 0, 0)


def emit(line: str) -> None:
    """输出一行协议并立即 flush。"""
    print(line, flush=True)


def get_crop_rect():
    """计算目标窗口相对主屏左上角的物理像素 crop 矩形（含边界 clamp）。

    返回 (x, y, w, h) 整数元组。DWM 查询失败（句柄失效 / API 异常）时返回零矩形
    （调用方按 baseline 处理），避免目标窗口在事件与查询之间销毁时抛出未捕获异常。
    """
    rect = RECT()
    try:
        hr = dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(target_hwnd),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(RECT),
        )
    except OSError:
        return (0, 0, 0, 0)
    if hr != 0:
        return (0, 0, 0, 0)
    x = rect.left - mon_phys_left
    y = rect.top - mon_phys_top
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    # clamp 到主屏物理边界（可能损边缘，已知限制，见设计 §9.4）
    x = max(0, x)
    y = max(0, y)
    if x + w > monitor_w:
        x = monitor_w - w
        if x < 0:
            x = 0
    if y + h > monitor_h:
        y = monitor_h - h
        if y < 0:
            y = 0
    return (int(round(x)), int(round(y)), int(round(w)), int(round(h)))


def find_target_window(title_lower: str):
    """EnumWindows 按标题子串（大小写不敏感）匹配，返回第一个匹配 hwnd（int）或 None。"""
    found = []

    def enum_cb(hwnd, lparam):
        if found:
            return False  # 已找到，停止枚举
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_lower in buf.value.lower():
            found.append(int(hwnd))
            return False
        return True

    cb = EnumWindowsProc(enum_cb)
    user32.EnumWindows(cb, 0)
    # cb 引用在 EnumWindows 返回前保持存活；返回后 found 已填充
    return found[0] if found else None


def schedule_timer() -> None:
    global pending_timer
    cancel_timer()
    pending_timer = threading.Timer(MOVE_CONFIRM_DELAY_S, timer_cb)
    pending_timer.daemon = True
    pending_timer.start()


def cancel_timer() -> None:
    global pending_timer
    if pending_timer is not None:
        pending_timer.cancel()
        pending_timer = None


def timer_cb() -> None:
    with state_lock:
        if terminated or not move_pending or not should_record:
            cancel_timer()
            return
        _location_logic(is_timer=True)


def _location_logic(is_timer: bool) -> None:
    """移动去抖核心（调用方须持 state_lock）。"""
    global move_pending, candidate_rect, terminated
    cur = get_crop_rect()
    if cur == baseline_rect:
        # 回弹到 baseline → 取消待确认
        move_pending = False
        candidate_rect = None
        cancel_timer()
        return
    if not move_pending:
        candidate_rect = cur
        move_pending = True
        schedule_timer()
        return
    # 已在待确认
    if cur == candidate_rect:
        if is_timer:
            # 事件即时读 + ~150ms 复读两次一致 → 确认移动结束
            emit("STOP MOVED")
            terminated = True
            move_pending = False
            candidate_rect = None
            cancel_timer()
            post_quit_to_main()
        # 来自事件流且一致：等待定时复读，无需动作
        return
    # 位置再次变化（仍在拖拽/动画）→ 更新候选并重新计时
    candidate_rect = cur
    move_pending = True
    schedule_timer()


def _clear_move_state() -> None:
    """暂停/恢复时清理可能遗留的移动去抖状态。"""
    global move_pending, candidate_rect
    move_pending = False
    candidate_rect = None
    cancel_timer()


def _get_window_pid(hwnd_i: int) -> int:
    """返回窗口所属进程 pid（用于忽略 CoWatch 自身窗口抢焦点）。"""
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(wintypes.HWND(hwnd_i), ctypes.byref(pid))
    return int(pid.value)


def _get_window_class(hwnd_i: int) -> str:
    """返回窗口类名（用于启发式过滤 IME/Toast/任务栏等无关注窗口）。"""
    buf = ctypes.create_unicode_buffer(256)
    length = user32.GetClassNameW(wintypes.HWND(hwnd_i), buf, 256)
    return buf.value if length > 0 else ''


def schedule_fg_timer() -> None:
    """启动前台丢失去抖定时器（500ms）。"""
    global fg_loss_timer
    cancel_fg_timer()
    fg_loss_timer = threading.Timer(0.5, _foreground_lost_cb)
    fg_loss_timer.daemon = True
    fg_loss_timer.start()


def cancel_fg_timer() -> None:
    """取消前台丢失去抖定时器（若存在）。"""
    global fg_loss_timer
    if fg_loss_timer is not None:
        fg_loss_timer.cancel()
        fg_loss_timer = None


def _foreground_lost_cb() -> None:
    """去抖到期：若目标仍非前台，则真正发出 PAUSE FOREGROUND_LOST。"""
    global fg_loss_pending, fg_loss_timer, should_record
    with state_lock:
        if terminated or not fg_loss_pending:
            return
        fg_loss_pending = False
        fg_loss_timer = None
        # 双保险：定时器到期时若目标已自行恢复到前台，则不暂停
        if is_foreground and not is_minimized:
            should_record = True
            return
        emit("PAUSE FOREGROUND_LOST")
        _clear_move_state()
        should_record = False


def win_event_proc(hook, event, hwnd, id_object, id_child, dw_event_thread, dwms_event_time):
    global is_foreground, is_minimized, should_record, baseline_rect, terminated, fg_loss_pending
    if id_object != OBJID_WINDOW:
        return
    hwnd_i = int(hwnd)
    with state_lock:
        if terminated:
            return
        if event == EVENT_OBJECT_DESTROY:
            if hwnd_i == target_hwnd:
                emit("STOP CLOSED")
                terminated = True
                _clear_move_state()
                post_quit_to_main()
            return
        if event == EVENT_OBJECT_MINIMIZESTART:
            if hwnd_i == target_hwnd:
                # 真最小化：取消任何进行中的前台去抖，按原逻辑真暂停（不去抖）
                cancel_fg_timer()
                fg_loss_pending = False
                is_minimized = True
                new_should = is_foreground and not is_minimized
                if (not new_should) and (should_record or fg_loss_pending):
                    emit("PAUSE MINIMIZED")
                _clear_move_state()
                should_record = new_should
            return
        if event == EVENT_OBJECT_MINIMIZEEND:
            if hwnd_i == target_hwnd:
                is_minimized = False
                new_should = is_foreground and not is_minimized
                if new_should and (not should_record):
                    baseline_rect = get_crop_rect()
                    _clear_move_state()
                    emit("RESUME")
                should_record = new_should
            return
        if event == EVENT_SYSTEM_FOREGROUND:
            is_foreground = (hwnd_i == target_hwnd)
            new_should = is_foreground and not is_minimized
            if new_should and (not should_record):
                # 目标重新成为前台（含去抖窗口内恢复）→ 取消去抖并恢复
                cancel_fg_timer()
                fg_loss_pending = False
                baseline_rect = get_crop_rect()
                _clear_move_state()
                emit("RESUME")
            elif (not new_should) and should_record:
                # 目标失去前台：先过滤无关注窗口
                # （CoWatch 自身窗口抢焦点 / IME 候选 / Toast / 任务栏）→ 直接忽略，不暂停
                if _get_window_pid(hwnd_i) in ignore_pids:
                    cancel_fg_timer()
                    fg_loss_pending = False
                    return
                if _get_window_class(hwnd_i) in IGNORE_CLASS_NAMES:
                    cancel_fg_timer()
                    fg_loss_pending = False
                    return
                # 真实前台丢失 → 启动 500ms 去抖，不立即暂停（短暂丢失不暂停）
                fg_loss_pending = True
                schedule_fg_timer()
            should_record = new_should
            return
        if event == EVENT_OBJECT_LOCATIONCHANGE:
            if hwnd_i == target_hwnd and should_record:
                _location_logic(is_timer=False)
            return


def main() -> None:
    # 双保险：stdout 行缓冲（print 已 flush=True）
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    if len(sys.argv) < 2:
        emit("NOT_FOUND")
        return
    title = sys.argv[1].lower()

    # 解析 --ignore-pid N（可多次传入），收集到 ignore_pids（覆盖 CoWatch 主进程等）
    parsed_ignore = set()
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == '--ignore-pid' and i + 1 < len(sys.argv):
            try:
                parsed_ignore.add(int(sys.argv[i + 1]))
            except ValueError:
                pass
            i += 2
        else:
            i += 1
    # 哨兵自身进程 pid 双保险（WINEVENT_SKIPOWNPROCESS 已覆盖自身进程事件）
    parsed_ignore.add(os.getpid())
    global ignore_pids
    ignore_pids = parsed_ignore

    # 必须在任何 DPI / 坐标查询之前设定 DPI awareness
    try:
        if shcore.SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE) != 0:
            user32.SetProcessDPIAware()
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass

    global target_hwnd, is_foreground, is_minimized, should_record, baseline_rect
    global mon_phys_left, mon_phys_top, monitor_w, monitor_h

    target_hwnd = find_target_window(title)
    if not target_hwnd:
        emit("NOT_FOUND")
        return

    hwnd_obj = wintypes.HWND(target_hwnd)

    # 显示器 / DPI 常量（单屏主屏，会话内固定）
    hmon = user32.MonitorFromWindow(hwnd_obj, MONITOR_DEFAULTTONEAREST)
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    dpi_x = wintypes.UINT(96)
    dpi_y = wintypes.UINT(96)
    shcore.GetDpiForMonitor(
        hmon, MDT_EFFECTIVE_DPI,
        ctypes.byref(dpi_x), ctypes.byref(dpi_y),
    )
    scale = dpi_x.value / 96.0
    mon_phys_left = mi.rcMonitor.left * scale
    mon_phys_top = mi.rcMonitor.top * scale
    monitor_w = (mi.rcMonitor.right - mi.rcMonitor.left) * scale
    monitor_h = (mi.rcMonitor.bottom - mi.rcMonitor.top) * scale

    baseline_rect = get_crop_rect()
    # 启动首行：RECT
    emit("RECT %d %d %d %d" % baseline_rect)

    # 初始状态查询（启动即前台可见为常见情形）
    fg_hwnd = int(user32.GetForegroundWindow())
    is_foreground = (fg_hwnd == target_hwnd)
    is_minimized = bool(user32.IsIconic(hwnd_obj))
    should_record = is_foreground and not is_minimized

    # 注册事件钩子（所有进程 / 所有线程；跳过自身进程事件）
    g_win_event_proc = WinEventProcType(win_event_proc)
    hook = user32.SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_OBJECT_LOCATIONCHANGE,
        None,
        g_win_event_proc,
        0,
        0,
        ctypes.c_uint(EVENT_HOOK_FLAGS),
    )
    if not hook:
        # 钩子注册失败：无事件可投递，静默退出（RECT 已交付，上层按既有机制兜底）
        return

    # 主线程消息泵（WINEVENT_OUTOFCONTEXT 回调在同线程触发）
    global main_thread_id
    main_thread_id = kernel32.GetCurrentThreadId()
    msg = MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
        if terminated:
            # 兜底：事件回调已置位 terminated，确保主泵退出（不依赖跨线程 WM_QUIT）
            user32.PostQuitMessage(0)
            break


if __name__ == "__main__":
    main()
