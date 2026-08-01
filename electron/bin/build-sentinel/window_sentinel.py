#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""window_sentinel — CoWatch 窗口哨兵（Python + ctypes 实现）

通过 Win32 API 监听目标窗口的生命周期事件，向 stdout 输出行协议，
供 sentinel-client.ts 解析（协议语言无关，与历史 Rust 版 100% 兼容）。

stdout 行协议：
  STOP CLOSED                窗口销毁 → 结束录制（stop）
  NOT_FOUND                  未找到目标窗口 → 退出（码 0）

所有协议输出均使用 print(..., flush=True)（并在启动时 reconfigure 行缓冲），
确保 sentinel-client 的 readline 不会因 Python 块缓冲而卡住。
"""

import sys
import ctypes
import threading
from ctypes import wintypes

# ─── Win32 常量 ───────────────────────────────────────────────────────────
EVENT_OBJECT_DESTROY = 0x8001

WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002
EVENT_HOOK_FLAGS = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS  # 0x0002

OBJID_WINDOW = 0

# ─── ctypes 结构与函数原型 ────────────────────────────────────────────────
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


user32 = ctypes.windll.user32
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

# SetWinEventHook
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
# PostThreadMessageW（用于将 WM_QUIT 投递到主消息泵线程，确保进程干净退出）
user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
]
user32.PostThreadMessageW.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.argtypes = []
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

# ─── 模块级状态 ──────────────────────────────────────────────────────────
target_hwnd = 0
terminated = False
state_lock = threading.Lock()

# 持有 WinEvent 回调引用，防止被 GC
g_win_event_proc = None

# 主消息泵线程 id（用于跨线程投递 WM_QUIT，确保进程干净退出）
main_thread_id = 0
WM_QUIT = 0x0012


def post_quit_to_main() -> None:
    """向主消息泵线程投递 WM_QUIT，使其在 GetMessageW 循环中干净退出。

    统一经主线程 id 投递，保持与历史实现一致。
    """
    if main_thread_id:
        user32.PostThreadMessageW(main_thread_id, WM_QUIT, 0, 0)


def emit(line: str) -> None:
    """输出一行协议并立即 flush。"""
    print(line, flush=True)


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


def win_event_proc(hook, event, hwnd, id_object, id_child, dw_event_thread, dwms_event_time):
    global terminated
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
                post_quit_to_main()
            return


def main() -> None:
    # 双保险：stdout 行缓冲（print 已 flush=True）
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    # ── 参数解析：HWND 主契约 ──
    #   - --hwnd <N>       ：十进制或 0x 十六进制 HWND（推荐，CoWatch 主契约）
    #   - 位置参数数字     ：同上（向后兼容旧 [hwnd] 调用）
    #   - 位置参数非数字   ：视作标题子串，回退 find_target_window（deprecated）
    parsed_hwnd = 0
    positional = []
    i = 1
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == '--hwnd' and i + 1 < len(sys.argv):
            try:
                parsed_hwnd = int(sys.argv[i + 1], 0)
            except ValueError:
                pass
            i += 2
        else:
            positional.append(a)
            i += 1

    global target_hwnd

    # HWND 主契约：--hwnd 或位置参数数字 → 直接取；否则回退标题子串匹配（deprecated 兼容）
    if parsed_hwnd:
        target_hwnd = parsed_hwnd
    elif positional:
        first = positional[0]
        try:
            target_hwnd = int(first, 0)  # 十进制或 0x 十六进制 HWND
        except ValueError:
            target_hwnd = find_target_window(first.lower())  # 非数字 → 标题子串回退
    else:
        emit("NOT_FOUND")
        return

    if not target_hwnd:
        emit("NOT_FOUND")
        return

    # 注册事件钩子（所有进程 / 所有线程；跳过自身进程事件）
    g_win_event_proc = WinEventProcType(win_event_proc)
    hook = user32.SetWinEventHook(
        EVENT_OBJECT_DESTROY,
        EVENT_OBJECT_DESTROY,
        None,
        g_win_event_proc,
        0,
        0,
        ctypes.c_uint(EVENT_HOOK_FLAGS),
    )
    if not hook:
        # 钩子注册失败：无事件可投递，静默退出（上层按既有机制兜底）
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
