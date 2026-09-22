"""
uia_sender.py — 纯键盘模拟的微信消息发送器
=================================================================

原理：
  完全通过键盘快捷键操作微信，无鼠标/无 UIA ValuePattern。
  剪贴板 (pyperclip) + SendKeys 完成一切操作。

工作流：
  1. 定位微信窗口并激活到前台
  2. Ctrl+F 搜索联系人 → Enter 进入聊天
  3. 剪贴板复制消息 → Ctrl+V 粘贴 → Enter 发送
  4. 图片通过 PowerShell 复制到剪贴板 → Ctrl+V → Enter

依赖:
  pip install uiautomation pyperclip
  发送图片需要 PowerShell (Windows 自带)
"""

from contextlib import contextmanager, ExitStack
import logging
import ntpath
import re
import os
import platform
import random
import subprocess
import sys
import threading
import time

from uia_native import NativeWindows

log = logging.getLogger("weflow-bridge")


class BaseSender:
    """消息发送器基类"""
    def send_text(self, contact: str, text: str) -> bool:
        raise NotImplementedError

    def send_image(self, contact: str, image_path: str) -> bool:
        raise NotImplementedError

    def send_file(self, contact: str, file_path: str) -> bool:
        raise NotImplementedError


class UiaSender(BaseSender):
    """
    纯键盘模拟的微信消息发送器。

    不依赖 UIA ValuePattern / InvokePattern / 鼠标点击，
    全程使用剪贴板 + SendKeys 键盘快捷键操作。
    """

    WECHAT_TITLES = ["微信", "WeChat"]
    SEARCH_POPUP_CLASS = "Qt51514QWindowToolSaveBits"
    WEB_SURFACE_PREFIX = "Chrome_WidgetWin_"
    SEARCH_RESULTS_TIMEOUT = 5.0
    CHAT_SWITCH_TIMEOUT = 5.0
    CHAT_READY_STABLE_SECONDS = 0.8
    ROUTE_POLL_SECONDS = 0.1
    WINDOW_RETRY_SECONDS = 3.0

    def __init__(self, search_enabled: bool = True, detailed_logging: bool = False, direct_window: bool = False):
        self._lock = threading.Lock()
        self._auto = None
        self._ready = False
        self._not_ready_reason = "UIA has not been initialized"
        self._last_not_ready_diagnostics_at = None
        self._last_route_signature = None
        self._native = None
        self._hwnd = 0
        self._window_pid = 0
        self._next_window_retry = 0.0

        # 微信窗口
        self._window = None

        # 最近联系人缓存（相同目标跳过搜索，快速发送）
        self._last_contact = ""

        self.search_enabled = search_enabled
        self.direct_window = direct_window
        self.detailed_logging = bool(detailed_logging)

        self._init()

    # ================================================================
    # 初始化
    # ================================================================

    def _init(self):
        """Do not retain UIA COM controls across sender/thread-pool calls."""
        self._log_runtime_context()
        with self._uia_context() as initialized:
            if initialized and not self.direct_window:
                self._ensure_window()

    def set_detailed_logging(self, enabled: bool):
        self.detailed_logging = bool(enabled)

    def _log_detail(self, message, *args):
        if getattr(self, "detailed_logging", False):
            log.info(message, *args)

    def _log_detail_exception(self, message, *args):
        if getattr(self, "detailed_logging", False):
            log.exception(message, *args)

    @contextmanager
    def _uia_context(self):
        with self._lock:
            if self._auto is None and time.monotonic() < self._next_window_retry:
                yield False
                return
            with ExitStack() as stack:
                initialized = False
                try:
                    if self._auto is None:
                        import uiautomation as auto
                        self._auto = auto
                        self._log_detail("UIA module loaded: version=%s module=%s",
                                         getattr(auto, "__version__", "unknown"), auto.__file__)
                    stack.enter_context(self._auto.UIAutomationInitializerInThread())
                    if self._native is None:
                        self._native = NativeWindows()
                    initialized = True
                except Exception as e:
                    self._invalidate_window(f"UIA initialization failed: {type(e).__name__}: {e}")
                    self._next_window_retry = time.monotonic() + self.WINDOW_RETRY_SECONDS
                    if self.detailed_logging:
                        log.exception("UIA initialization failed in current thread")
                    else:
                        log.error("%s", self._not_ready_reason)
                # Each call builds a fresh Control in the COM-initialized calling thread.
                self._window = None
                try:
                    yield initialized
                finally:
                    self._window = None

    def _invalidate_window(self, reason):
        self._ready = False
        self._window = None
        self._hwnd = 0
        self._window_pid = 0
        self._last_contact = ""
        self._last_route_signature = None
        self._not_ready_reason = reason

    @staticmethod
    def _compact(value, limit: int = 160) -> str:
        text = str(value or "").replace("\r", "\\r").replace("\n", "\\n")
        return text if len(text) <= limit else text[:limit - 3] + "..."

    @staticmethod
    def _control_value(control, name, default="?"):
        try:
            value = getattr(control, name, default)
            return value() if callable(value) else value
        except Exception as e:
            return f"<{type(e).__name__}: {e}>"

    def _process_image(self, pid) -> str:
        if not isinstance(pid, int) or pid <= 0:
            return ""
        try:
            return self._native.process_image(pid)
        except Exception:
            self._log_detail_exception("UIA process image query failed: pid=%s", pid)
            return ""

    def _describe_control(self, control) -> str:
        rect = self._control_value(control, "BoundingRectangle", None)
        if rect is None:
            rect_text = "?"
        else:
            try:
                rect_text = f"({rect.left},{rect.top},{rect.right},{rect.bottom})"
            except Exception:
                rect_text = self._compact(rect)
        pid = self._control_value(control, "ProcessId", "?")
        fields = {
            "name": self._compact(self._control_value(control, "Name", "")),
            "class": self._compact(self._control_value(control, "ClassName", "")),
            "type": self._compact(self._control_value(control, "ControlTypeName", "")),
            "automation_id": self._compact(self._control_value(control, "AutomationId", "")),
            "pid": pid,
            "process": self._compact(self._process_image(pid)),
            "hwnd": self._control_value(control, "NativeWindowHandle", "?"),
            "offscreen": self._control_value(control, "IsOffscreen", "?"),
            "rect": rect_text,
        }
        return " ".join(f"{key}={value!r}" for key, value in fields.items())

    def _log_runtime_context(self):
        self._log_detail(
            "UIA runtime: pid=%s thread=%s python=%s executable=%s platform=%s cwd=%s "
            "session=%s user=%s module=%s",
            os.getpid(),
            threading.get_ident(),
            self._compact(sys.version),
            sys.executable,
            platform.platform(),
            os.getcwd(),
            os.environ.get("SESSIONNAME", ""),
            os.environ.get("USERNAME", ""),
            os.path.abspath(__file__),
        )

    def _log_native_window_state(self):
        try:
            hwnd = self._native.foreground()
            self._log_detail("UIA Win32 foreground: %r", self._native.window_info(hwnd))
        except Exception:
            self._log_detail_exception("UIA Win32 window diagnostics failed")

    def _enumerate_top_level_controls(self):
        try:
            root = self._auto.GetRootControl()
            windows = list(root.GetChildren())
        except Exception:
            self._log_detail_exception("UIA top-level window enumeration failed")
            return []

        self._log_detail("UIA top-level enumeration: count=%d root=%s", len(windows), self._describe_control(root))
        for index, window in enumerate(windows):
            name = str(self._control_value(window, "Name", "") or "")
            class_name = str(self._control_value(window, "ClassName", "") or "")
            title_match = any(keyword in name for keyword in self.WECHAT_TITLES)
            excluded_class = class_name in ("Chrome_WidgetWin_1", "CabinetWClass")
            self._log_detail(
                "UIA top-level[%d]: %s title_match=%s excluded_class=%s",
                index,
                self._describe_control(window),
                title_match,
                excluded_class,
            )
        return windows

    @staticmethod
    def _is_wechat_class(class_name):
        return class_name in ("WeChatMainWndForPC", "WeixinMainWndForPC") or bool(
            re.fullmatch(r"Qt\d+QWindowIcon", class_name)
        )

    def _candidate_rejection(self, info):
        if not info:
            return "invalid HWND or unreadable Win32 rectangle"
        if not self._is_wechat_class(info["class"]):
            return "not a supported main-window class"
        image = self._process_image(info["pid"])
        if ntpath.basename(image).casefold() not in ("weixin.exe", "wechat.exe"):
            return "not a verified Weixin.exe/WeChat.exe process"
        if info["owner"]:
            return "owned popup or dialog"
        if not info["visible"] or not info["enabled"]:
            return "hidden or disabled window"
        left, top, right, bottom = info["rect"]
        if not info["iconic"] and (right <= left or bottom <= top):
            return "empty Win32 rectangle"
        return ""

    def _find_window(self):
        """Titles can be contact names. Require process + class + native window state."""
        self._invalidate_window("no usable WeChat window found")
        self._log_native_window_state()
        candidates = []
        seen = set()
        for window in self._enumerate_top_level_controls():
            hwnd = self._control_value(window, "NativeWindowHandle", 0)
            if not isinstance(hwnd, int) or not hwnd or hwnd in seen:
                continue
            seen.add(hwnd)
            try:
                info = self._native.window_info(hwnd)
                reason = self._candidate_rejection(info)
                if info and self._control_value(window, "ProcessId", 0) != info["pid"]:
                    reason = "UIA/Win32 PID mismatch (stale control)"
                self._log_detail("UIA candidate: hwnd=%s native=%r accepted=%s reason=%s",
                                 hwnd, info, not reason, reason or "verified process/class/window")
                if not reason:
                    candidates.append((window, info))
            except Exception:
                self._log_detail_exception("UIA candidate validation failed: hwnd=%s", hwnd)
        if len(candidates) != 1:
            if candidates:
                self._not_ready_reason = "multiple usable WeChat windows; refusing ambiguous target"
            log.warning("UIA window selection failed: count=%s reason=%s",
                        len(candidates), self._not_ready_reason)
            return False
        self._window, info = candidates[0]
        self._hwnd, self._window_pid = info["hwnd"], info["pid"]
        self._ready = True
        self._not_ready_reason = ""
        self._next_window_retry = 0.0
        self._log_detail("UIA WeChat window matched by process/class: %s native=%r",
                         self._describe_control(self._window), info)
        return True

    def _log_not_ready_diagnostics(self, context: str):
        log.error(
            "UIA Sender not ready: context=%s reason=%s auto_loaded=%s window_cached=%s",
            context,
            self._not_ready_reason,
            self._auto is not None,
            self._window is not None,
        )
        now = time.monotonic()
        if (
            self._last_not_ready_diagnostics_at is not None
            and now - self._last_not_ready_diagnostics_at < 15.0
        ):
            return
        self._last_not_ready_diagnostics_at = now
        self._log_runtime_context()
        self._log_native_window_state()
        if self._auto is not None:
            self._enumerate_top_level_controls()

    def _find_direct_window(self, contact: str) -> bool:
        """Resolve each send afresh. HWNDs are transient, never persistent chat IDs."""
        self._invalidate_window("no unique open chat window")
        target = str(contact or "").strip()
        if not target:
            log.error("UIA 独立窗口发送：目标会话名称为空，已拒绝发送")
            return False
        candidates = []
        seen = set()
        try:
            for window in self._enumerate_top_level_controls():
                hwnd = window.NativeWindowHandle
                if not hwnd or hwnd in seen:
                    continue
                seen.add(hwnd)
                info = self._native.window_info(hwnd)
                if self._candidate_rejection(info):
                    continue
                if window.ProcessId != info["pid"]:
                    continue
                if info.get("title", "") == target and window.Name == target:
                    candidates.append((window, info))
            if len(candidates) != 1:
                log.error("UIA 独立窗口发送：会话 %r 匹配到 %d 个窗口；请手动打开白名单会话的独立窗口并避免重名，不会回退搜索",
                          target, len(candidates))
                return False
            self._window, info = candidates[0]
            self._hwnd, self._window_pid = info["hwnd"], info["pid"]
            self._ready = True
            self._not_ready_reason = ""
            self._last_contact = target
            self._next_window_retry = 0.0
            self._log_detail("UIA direct window selected: contact=%r hwnd=%s pid=%s",
                             target, self._hwnd, self._window_pid)
            return True
        except Exception:
            log.exception("UIA 独立窗口枚举失败，已拒绝发送")
            self._invalidate_window("direct window enumeration failed")
            return False

    def _guard_direct_target(self, contact: str) -> bool:
        """Recheck immediately before clipboard/paste/Enter; never steal focus back."""
        if not self.direct_window:
            return True
        try:
            info = self._native.window_info(self._hwnd)
            target = str(contact or "").strip()
            if (self._candidate_rejection(info) or info["iconic"]
                    or info["pid"] != self._window_pid
                    or self._native.foreground() != self._hwnd
                    or info.get("title", "") != target
                    or self._window.Name != target
                    or self._window.ProcessId != self._window_pid
                    or self._window.NativeWindowHandle != self._hwnd):
                raise RuntimeError("target title, process or foreground changed")
            surface = self._route_surface_state()
            if surface["search"] or surface["web"]:
                raise RuntimeError("target is showing a search/web surface")
            return True
        except Exception:
            log.warning("UIA 独立窗口目标状态已变化，取消发送: %r", contact, exc_info=self.detailed_logging)
            return False

    def _send_target_key(self, contact: str, key: str) -> bool:
        if not self._guard_direct_target(contact):
            return False
        self._auto.SendKeys(key)
        return True

    def _ensure_window(self, contact: str = "") -> bool:
        if self.direct_window:
            if self._auto is None or self._native is None:
                return False
            return self._find_direct_window(contact)
        if self._auto is None or self._native is None:
            return False
        if self._hwnd:
            try:
                info = self._native.window_info(self._hwnd)
                if not self._candidate_rejection(info) and info["pid"] == self._window_pid:
                    if self._window is None:
                        self._window = self._auto.ControlFromHandle(self._hwnd)
                    if (self._window is not None
                            and self._window.NativeWindowHandle == self._hwnd
                            and self._window.ProcessId == self._window_pid):
                        self._ready = True
                        return True
            except Exception:
                self._log_detail_exception("UIA cached window validation failed")
            self._invalidate_window("cached WeChat window is no longer usable")
        now = time.monotonic()
        if now < self._next_window_retry:
            return False
        found = self._find_window()
        if not found:
            self._next_window_retry = time.monotonic() + self.WINDOW_RETRY_SECONDS
            self._log_not_ready_diagnostics("ensure_window")
        return found

    def _activate(self) -> bool:
        """Only activate the selected HWND; never find another window by class."""
        try:
            info = self._native.window_info(self._hwnd)
            if self._candidate_rejection(info) or info["pid"] != self._window_pid:
                self._invalidate_window("selected window changed before activation")
                return False
            self._native.activate(self._hwnd)
            time.sleep(0.3)
            info = self._native.window_info(self._hwnd)
            usable = (not self._candidate_rejection(info) and not info["iconic"]
                      and info["pid"] == self._window_pid)
            foreground = self._native.foreground()
            self._log_detail("UIA activation: selected_hwnd=%s foreground_hwnd=%s usable=%s native=%r",
                             self._hwnd, foreground, usable, info)
            return usable and foreground == self._hwnd
        except Exception:
            self._log_detail_exception("UIA selected-window activation failed")
            return False

    # ================================================================
    # 联系人切换
    # ================================================================

    def _visible_child_classes(self):
        """Return visible direct-child window classes for route-state checks."""
        classes = []
        try:
            for index, child in enumerate(self._window.GetChildren()):
                try:
                    rect = child.BoundingRectangle
                    if not rect.isempty():
                        classes.append(str(child.ClassName or ""))
                except Exception:
                    self._log_detail_exception("UIA child read failed: index=%d", index)
                    raise
        except Exception:
            self._log_detail_exception(
                "UIA WeChat child enumeration failed: window=%s",
                self._describe_control(self._window),
            )
            raise
        return classes

    def _route_surface_state(self):
        classes = self._visible_child_classes()
        if not classes:
            raise RuntimeError("UIA chat surface is unreadable: no visible child windows")
        state = {
            "search": self.SEARCH_POPUP_CLASS in classes,
            "web": any(name.startswith(self.WEB_SURFACE_PREFIX) for name in classes),
        }
        signature = (state["search"], state["web"], tuple(classes))
        if signature != getattr(self, "_last_route_signature", None):
            self._log_detail(
                "UIA route surface changed: search=%s web=%s visible_child_classes=%r",
                state["search"],
                state["web"],
                classes,
            )
            self._last_route_signature = signature
        return state

    def _wait_for_search_results(self) -> bool:
        started = time.monotonic()
        self._log_detail(
            "UIA waiting for search popup: expected_class=%r timeout=%.1fs",
            self.SEARCH_POPUP_CLASS,
            self.SEARCH_RESULTS_TIMEOUT,
        )
        deadline = started + self.SEARCH_RESULTS_TIMEOUT
        while True:
            now = time.monotonic()
            if now >= deadline:
                log.error(
                    "UIA search popup timeout: elapsed=%.2fs expected_class=%r visible_child_classes=%r",
                    now - started,
                    self.SEARCH_POPUP_CLASS,
                    self._visible_child_classes(),
                )
                return False
            if self._route_surface_state()["search"]:
                self._log_detail("UIA search popup detected: elapsed=%.2fs", now - started)
                return True
            time.sleep(self.ROUTE_POLL_SECONDS)

    def _wait_for_chat_surface(self, contact: str) -> bool:
        """Wait until search is gone and the plain chat surface stays stable."""
        started = time.monotonic()
        deadline = started + self.CHAT_SWITCH_TIMEOUT
        ready_since = None
        self._log_detail(
            "UIA waiting for chat surface: contact=%r timeout=%.1fs stable_for=%.1fs",
            contact,
            self.CHAT_SWITCH_TIMEOUT,
            self.CHAT_READY_STABLE_SECONDS,
        )
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            state = self._route_surface_state()
            if state["web"]:
                log.error(
                    "UIA chat switch entered web search: contact=%r elapsed=%.2fs classes=%r",
                    contact,
                    now - started,
                    self._visible_child_classes(),
                )
                return False
            if state["search"]:
                ready_since = None
            elif ready_since is None:
                ready_since = now
            elif now - ready_since >= self.CHAT_READY_STABLE_SECONDS:
                self._log_detail(
                    "UIA chat surface stable: contact=%r elapsed=%.2fs classes=%r",
                    contact,
                    now - started,
                    self._visible_child_classes(),
                )
                return True
            time.sleep(self.ROUTE_POLL_SECONDS)
        classes = self._visible_child_classes()
        if self.SEARCH_POPUP_CLASS in classes:
            self._auto.SendKeys('{Esc}')
            log.warning("UIA sent Esc after chat switch timeout because search popup remained visible")
        log.error(
            "UIA chat switch timeout: contact=%r elapsed=%.2fs classes=%r",
            contact,
            time.monotonic() - started,
            classes,
        )
        return False

    def _switch_contact(self, contact: str) -> bool:
        """
        切换到指定联系人/群聊的聊天窗口。

        纯键盘：Ctrl+F → 粘贴联系人名 → Enter
        """
        if not self._ensure_window():
            return False
        if not self._activate():
            return False

        auto = self._auto

        # Ctrl+F 打开搜索
        auto.SendKeys('{Ctrl}f')
        time.sleep(0.5)

        # Ctrl+A 全选 → 清空已有内容
        auto.SendKeys('{Ctrl}a')
        time.sleep(0.15)

        # 粘贴联系人名。新微信的搜索结果是独立弹层；等弹层真实
        # 出现后再按回车，不能把固定 sleep 当成“已经加载完成”。
        import pyperclip
        pyperclip.copy(contact)
        time.sleep(0.1)
        auto.SendKeys('{Ctrl}v')
        if not self._wait_for_search_results():
            auto.SendKeys('{Esc}')
            log.error(f"微信搜索结果未出现，已取消发送: {contact}")
            return False

        auto.SendKeys('{Enter}')
        if not self._wait_for_chat_surface(contact):
            return False

        log.info(f"已确认切到联系人: {contact}")
        return True

    # ================================================================
    # 发送文字 (纯键盘)
    # ================================================================

    def send_text(self, contact: str, text: str) -> bool:
        """
        发送文本消息。

        纯键盘方案：剪贴板 → Ctrl+V → Enter
        """
        with self._uia_context() as initialized:
            if not initialized:
                return False

            if not self._ensure_window(contact):
                log.error(f"[UIA✗] {contact}: 微信窗口不可用")
                return False

            # 安全检查：过滤 PIL 引用
            if "<PIL." in text or "PIL." in text:
                log.warning(f"跳过 PIL 引用消息: {text[:60]}")
                return False

            try:
                if not self._activate():
                    return False
                if not self._guard_direct_target(contact):
                    return False

                # 切换到联系人；失败时禁止继续向当前聊天窗口发送。
                if not self.direct_window and self.search_enabled and contact and contact != self._last_contact:
                    if not self._switch_contact(contact):
                        log.error(f"[UIA✗] {contact}: 切换联系人失败")
                        return False
                    self._last_contact = contact

                import pyperclip

                # 模拟真人随机延时
                time.sleep(random.uniform(0.3, 1.0))

                # 复制消息到剪贴板
                pyperclip.copy(text)
                time.sleep(random.uniform(0.1, 0.3))

                # Ctrl+V 粘贴
                if not self._send_target_key(contact, '{Ctrl}v'):
                    return False

                # 根据消息长度动态等待粘贴完成（长文本多等一会）
                paste_wait = min(len(text) * 0.02, 2.0) + random.uniform(0.3, 0.8)
                time.sleep(paste_wait)

                # Enter 发送
                if not self._send_target_key(contact, '{Enter}'):
                    return False

                log.info(f"[UIA✓] {contact}: {text[:50]}...")
                return True

            except Exception as e:
                log.error(f"[UIA✗] {contact}: {e}")
                return False

    # ================================================================
    # 发送图片 (剪贴板 + 纯键盘)
    # ================================================================

    def send_image(self, contact: str, image_path: str) -> bool:
        """
        发送图片。

        方案：PowerShell 复制图片到剪贴板 → Ctrl+V → Enter
        """
        with self._uia_context() as initialized:
            if not initialized:
                return False
            if not os.path.isfile(image_path):
                log.error(f"图片不存在: {image_path}")
                return False

            try:
                if not self._ensure_window(contact):
                    return False
                if not self._activate():
                    return False
                if not self._guard_direct_target(contact):
                    return False

                if not self.direct_window and self.search_enabled and contact and contact != self._last_contact:
                    if not self._switch_contact(contact):
                        log.error(f"[UIA✗] 图片 → {contact}: 切换联系人失败")
                        return False
                    self._last_contact = contact

                time.sleep(random.uniform(0.3, 0.8))

                # PowerShell 复制图片到剪贴板
                self._copy_image_to_clipboard(image_path)
                time.sleep(0.3)

                # Ctrl+V 粘贴
                if not self._send_target_key(contact, '{Ctrl}v'):
                    return False
                time.sleep(random.uniform(0.8, 1.5))  # 等待微信加载图片预览

                # Enter 发送
                if not self._send_target_key(contact, '{Enter}'):
                    return False

                log.info(f"[UIA✓] 图片 → {contact}: {os.path.basename(image_path)}")
                return True

            except Exception as e:
                log.error(f"[UIA✗] 图片 → {contact}: {e}")
                return False

    def _copy_image_to_clipboard(self, path: str):
        """复制图片到剪贴板（通过 PowerShell，避免 PIL 对象被当作文本复制）"""
        abs_path = os.path.abspath(path)
        try:
            subprocess.run([
                "powershell", "-WindowStyle", "Hidden", "-Command",
                f"Add-Type -AssemblyName System.Windows.Forms;"
                f"$img = [System.Drawing.Image]::FromFile('{abs_path}');"
                f"[System.Windows.Forms.Clipboard]::SetImage($img);"
                f"$img.Dispose()"
            ], check=True, timeout=10)
            log.debug("PowerShell 已复制图片到剪贴板")
        except Exception as e:
            log.error(f"复制图片到剪贴板失败: {e}")
            raise

    # ================================================================
    # Send files through the Windows file-drop clipboard format
    # ================================================================

    def send_file(self, contact: str, file_path: str) -> bool:
        """Paste and send one local file through the active WeChat window."""
        with self._uia_context() as initialized:
            if not initialized:
                return False

            abs_path = os.path.abspath(file_path)
            if not os.path.isfile(abs_path):
                log.error(f"File does not exist: {abs_path}")
                return False

            try:
                if not self._ensure_window(contact):
                    return False
                if not self._activate():
                    return False
                if not self._guard_direct_target(contact):
                    return False

                if not self.direct_window and self.search_enabled and contact and contact != self._last_contact:
                    if not self._switch_contact(contact):
                        log.error(f"[UIA failed] file -> {contact}: contact switch failed")
                        return False
                    self._last_contact = contact

                time.sleep(random.uniform(0.3, 0.8))
                self._copy_file_to_clipboard(abs_path)
                time.sleep(0.5)

                if not self._send_target_key(contact, '{Ctrl}v'):
                    return False
                file_size_mb = os.path.getsize(abs_path) / (1024 * 1024)
                time.sleep(min(1.0 + file_size_mb * 0.05, 5.0))

                if not self._send_target_key(contact, '{Enter}'):
                    return False
                log.info(f"[UIA ok] file -> {contact}: {os.path.basename(abs_path)}")
                return True

            except Exception as e:
                log.error(f"[UIA failed] file -> {contact}: {e}")
                return False

    def _copy_file_to_clipboard(self, path: str):
        """Copy one file as a Windows FileDropList clipboard item."""
        env = os.environ.copy()
        env["WEFLOW_FILE_TO_SEND"] = os.path.abspath(path)
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$path = [Environment]::GetEnvironmentVariable('WEFLOW_FILE_TO_SEND');"
            "$files = New-Object System.Collections.Specialized.StringCollection;"
            "[void]$files.Add($path);"
            "[System.Windows.Forms.Clipboard]::SetFileDropList($files)"
        )
        try:
            subprocess.run([
                "powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden",
                "-Command", script,
            ], check=True, timeout=10, env=env)
            log.debug("PowerShell copied file to clipboard")
        except Exception as e:
            log.error(f"Failed to copy file to clipboard: {e}")
            raise
