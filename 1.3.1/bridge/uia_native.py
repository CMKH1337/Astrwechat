"""Small, pointer-safe Win32 boundary for UIA window selection and activation."""
import ctypes
from ctypes import wintypes


class NativeWindows:
    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "IsWindow": ([wintypes.HWND], wintypes.BOOL),
            "IsWindowVisible": ([wintypes.HWND], wintypes.BOOL),
            "IsWindowEnabled": ([wintypes.HWND], wintypes.BOOL),
            "IsIconic": ([wintypes.HWND], wintypes.BOOL),
            "GetWindow": ([wintypes.HWND, wintypes.UINT], wintypes.HWND),
            "GetWindowRect": ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
            "GetWindowThreadProcessId": ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            "GetClassNameW": ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            "GetWindowTextW": ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            "GetForegroundWindow": ([], wintypes.HWND),
            "FindWindowW": ([wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
            "ShowWindow": ([wintypes.HWND, ctypes.c_int], wintypes.BOOL),
            "SetForegroundWindow": ([wintypes.HWND], wintypes.BOOL),
            "BringWindowToTop": ([wintypes.HWND], wintypes.BOOL),
            "AttachThreadInput": ([wintypes.DWORD, wintypes.DWORD, wintypes.BOOL], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.user32, name)
            fn.argtypes, fn.restype = args, result
        for name, args, result in (
            ("OpenProcess", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("QueryFullProcessImageNameW", [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                          ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
            ("GetCurrentThreadId", [], wintypes.DWORD),
        ):
            fn = getattr(self.kernel32, name)
            fn.argtypes, fn.restype = args, result

    def process_image(self, pid):
        handle = self.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return ""
        try:
            size = wintypes.DWORD(32768)
            buffer = ctypes.create_unicode_buffer(size.value)
            if self.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return buffer.value
            return ""
        finally:
            self.kernel32.CloseHandle(handle)

    def window_info(self, hwnd):
        if not hwnd or not self.user32.IsWindow(hwnd):
            return None
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rect = wintypes.RECT()
        if not self.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        name = ctypes.create_unicode_buffer(256)
        self.user32.GetClassNameW(hwnd, name, len(name))
        return {
            "hwnd": int(hwnd), "pid": pid.value, "class": name.value,
            "owner": self.user32.GetWindow(hwnd, 4) or 0,  # GW_OWNER
            "visible": bool(self.user32.IsWindowVisible(hwnd)),
            "enabled": bool(self.user32.IsWindowEnabled(hwnd)),
            "iconic": bool(self.user32.IsIconic(hwnd)),
            "rect": (rect.left, rect.top, rect.right, rect.bottom),
        }

    def foreground(self):
        return self.user32.GetForegroundWindow() or 0

    def activate(self, hwnd):
        info = self.window_info(hwnd)
        if not info:
            return False
        if info["iconic"]:
            self.user32.ShowWindow(hwnd, 9)  # SW_RESTORE; never show arbitrary hidden windows.
        current_tid = self.kernel32.GetCurrentThreadId()
        foreground = self.foreground()
        foreground_tid = self.user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        attached = False
        try:
            if foreground_tid and foreground_tid != current_tid:
                attached = bool(self.user32.AttachThreadInput(current_tid, foreground_tid, True))
            self.user32.BringWindowToTop(hwnd)
            self.user32.SetForegroundWindow(hwnd)
            return self.foreground() == hwnd
        finally:
            if attached:
                self.user32.AttachThreadInput(current_tid, foreground_tid, False)
