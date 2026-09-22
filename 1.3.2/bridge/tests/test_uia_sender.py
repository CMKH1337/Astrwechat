"""UIA route-state tests; no real WeChat, clipboard or keyboard calls."""
import sys
from contextlib import nullcontext
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


BRIDGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE))

import uia_sender


class Rect:
    def __init__(self, visible=True):
        self.visible = visible

    def isempty(self):
        return not self.visible


class Child:
    def __init__(self, class_name, visible=True, name="", pid=0, hwnd=0):
        self.ClassName = class_name
        self.Name = name
        self.ProcessId = pid
        self.NativeWindowHandle = hwnd
        self.ControlTypeName = "WindowControl"
        self.AutomationId = ""
        self.IsOffscreen = not visible
        self.BoundingRectangle = Rect(visible)


class Window:
    def __init__(self, states):
        self.states = list(states)

    def GetChildren(self):
        if len(self.states) > 1:
            state = self.states.pop(0)
        else:
            state = self.states[0] if self.states else []
        return [Child(name) for name in state]


class Root:
    Name = "Desktop"
    ClassName = "#32769"
    ProcessId = 0
    NativeWindowHandle = 0
    ControlTypeName = "PaneControl"
    AutomationId = ""
    IsOffscreen = False
    BoundingRectangle = Rect(True)

    def __init__(self, children):
        self.children = children

    def GetChildren(self):
        return self.children


class Auto:
    def __init__(self, root=None):
        self.keys = []
        self.root = root

    def SendKeys(self, keys):
        self.keys.append(keys)

    def GetRootControl(self):
        return self.root


def sender_with(states):
    sender = object.__new__(uia_sender.UiaSender)
    sender._window = Window(states)
    sender._auto = Auto()
    sender.detailed_logging = False
    sender.direct_window = False
    sender.SEARCH_RESULTS_TIMEOUT = 0.5
    sender.CHAT_SWITCH_TIMEOUT = 0.5
    sender.CHAT_READY_STABLE_SECONDS = 0.1
    sender.ROUTE_POLL_SECONDS = 0.01
    return sender


def native_for(*windows):
    native = Mock()
    infos = {
        window.NativeWindowHandle: dict(
            hwnd=window.NativeWindowHandle, pid=window.ProcessId,
            **{"class": window.ClassName}, owner=0, visible=True, enabled=True,
            iconic=False, rect=(10, 20, 870, 665), title=window.Name,
        ) for window in windows
    }
    native.window_info.side_effect = lambda hwnd: infos.get(hwnd)
    native.process_image.return_value = r"C:\Program Files\Tencent\Weixin\Weixin.exe"
    native.foreground.return_value = windows[0].NativeWindowHandle if windows else 0
    return native


def detection_sender(windows):
    with patch.object(uia_sender.UiaSender, "_init"):
        sender = uia_sender.UiaSender()
    sender._auto = Auto(Root(windows))
    sender._auto.UIAutomationInitializerInThread = Mock(side_effect=nullcontext)
    sender._auto.ControlFromHandle = Mock(
        side_effect=lambda hwnd: next(w for w in windows if w.NativeWindowHandle == hwnd)
    )
    sender._native = native_for(*windows)
    sender._log_native_window_state = Mock()
    return sender


class UiaSenderRouteTests(unittest.TestCase):
    def test_surface_state_distinguishes_search_chat_and_web(self):
        popup = uia_sender.UiaSender.SEARCH_POPUP_CLASS
        sender = sender_with([[popup]])
        self.assertEqual(sender._route_surface_state(), {"search": True, "web": False})

        sender._window = Window([["MMUIRenderSubWindowHW"]])
        self.assertEqual(sender._route_surface_state(), {"search": False, "web": False})

        sender._window = Window([["Chrome_WidgetWin_0", "MMUIRenderSubWindowHW"]])
        self.assertEqual(sender._route_surface_state(), {"search": False, "web": True})

    def test_find_window_logs_candidate_rejected_by_legacy_class_rule(self):
        sender = sender_with([[]])
        sender.set_detailed_logging(True)
        candidate = Child(
            "Chrome_WidgetWin_1",
            name="WeChat",
            pid=4321,
            hwnd=9876,
        )
        sender._auto = Auto(Root([candidate]))
        sender._window = None
        sender._native = native_for(candidate)
        sender._log_native_window_state = Mock()

        with self.assertLogs("weflow-bridge", level="INFO") as captured:
            sender._find_window()

        self.assertIsNone(sender._window)
        output = "\n".join(captured.output)
        self.assertIn("title_match=True", output)
        self.assertIn("excluded_class=True", output)
        self.assertIn("Weixin.exe", output)

    def test_find_window_logs_and_accepts_supported_candidate(self):
        sender = sender_with([[]])
        sender.set_detailed_logging(True)
        candidate = Child("Qt51514QWindowIcon", name="WeChat", pid=123, hwnd=456)
        sender._auto = Auto(Root([candidate]))
        sender._window = None
        sender._native = native_for(candidate)
        sender._log_native_window_state = Mock()

        with self.assertLogs("weflow-bridge", level="INFO") as captured:
            sender._find_window()

        self.assertIs(sender._window, candidate)
        output = "\n".join(captured.output)
        self.assertIn("pid=123", output)
        self.assertIn("hwnd=456", output)

    def test_detailed_logging_can_be_toggled(self):
        sender = sender_with([[]])
        with self.assertNoLogs("weflow-bridge", level="INFO"):
            sender._log_detail("hidden detail")

        sender.set_detailed_logging(True)
        with self.assertLogs("weflow-bridge", level="INFO") as captured:
            sender._log_detail("visible detail: %s", "ok")
        self.assertIn("visible detail: ok", "\n".join(captured.output))

    @patch.object(uia_sender.time, "sleep", return_value=None)
    @patch.object(uia_sender.time, "monotonic", side_effect=[0, 0.1])
    def test_waits_for_real_search_result_popup(self, _clock, _sleep):
        popup = uia_sender.UiaSender.SEARCH_POPUP_CLASS
        sender = sender_with([[popup]])
        self.assertTrue(sender._wait_for_search_results())

    @patch.object(uia_sender.time, "sleep", return_value=None)
    @patch.object(uia_sender.time, "monotonic", side_effect=[0, 0.1, 0.25])
    def test_chat_must_remain_stable_before_payload_can_be_pasted(self, _clock, _sleep):
        sender = sender_with([
            ["MMUIRenderSubWindowHW"],
            ["MMUIRenderSubWindowHW"],
        ])
        self.assertTrue(sender._wait_for_chat_surface("测试群"))
        self.assertEqual(sender._auto.keys, [])

    @patch.object(uia_sender.time, "sleep", return_value=None)
    @patch.object(uia_sender.time, "monotonic", side_effect=[0, 0.1])
    def test_web_search_is_rejected_before_message_clipboard_is_used(self, _clock, _sleep):
        sender = sender_with([["Chrome_WidgetWin_0", "MMUIRenderSubWindowHW"]])
        self.assertFalse(sender._wait_for_chat_surface("错误群名"))
        self.assertEqual(sender._auto.keys, [])


class UiaSenderReadinessTests(unittest.TestCase):
    def window(self, **kwargs):
        defaults = dict(class_name="Qt51514QWindowIcon", name="Contact title", pid=123, hwnd=456)
        defaults.update(kwargs)
        return Child(**defaults)

    def test_contact_title_is_accepted_without_wechat_keyword(self):
        window = self.window()
        sender = detection_sender([window])
        self.assertTrue(sender._ensure_window())
        self.assertTrue(sender._ready)
        self.assertEqual(sender._hwnd, 456)

    def test_zero_uia_rectangle_uses_valid_win32_rectangle(self):
        window = self.window(visible=False)
        sender = detection_sender([window])
        self.assertTrue(sender._find_window())

    def test_empty_native_window_is_rejected(self):
        window = self.window()
        sender = detection_sender([window])
        sender._native.window_info(456)["rect"] = (0, 0, 0, 0)
        self.assertFalse(sender._find_window())
        self.assertFalse(sender._ready)

    def test_minimized_window_is_discoverable_but_hidden_window_is_not(self):
        sender = detection_sender([self.window()])
        info = sender._native.window_info(456)
        info.update(iconic=True, rect=(-32000, -32000, -31840, -31972))
        self.assertTrue(sender._find_window())
        info["visible"] = False
        self.assertFalse(sender._find_window())

    def test_browser_explorer_popup_and_foreign_process_are_rejected(self):
        for cls in ("Chrome_WidgetWin_1", "CabinetWClass", "Qt51514QWindowToolSaveBits"):
            with self.subTest(cls=cls):
                sender = detection_sender([self.window(class_name=cls, name="WeChat")])
                self.assertFalse(sender._find_window())
        sender = detection_sender([self.window(name="WeChat")])
        for image in (r"C:\AstrWeChat.exe", r"C:\other.exe", ""):
            with self.subTest(image=image):
                sender._native.process_image.return_value = image
                self.assertFalse(sender._find_window())

    def test_owned_or_disabled_window_is_rejected(self):
        for field, value in (("owner", 999), ("enabled", False)):
            with self.subTest(field=field):
                sender = detection_sender([self.window()])
                sender._native.window_info(456)[field] = value
                self.assertFalse(sender._find_window())

    def test_legacy_window_class_and_process_remain_supported(self):
        for cls in ("WeChatMainWndForPC", "WeixinMainWndForPC", "Qt680QWindowIcon"):
            with self.subTest(cls=cls):
                sender = detection_sender([self.window(class_name=cls)])
                sender._native.process_image.return_value = r"C:\WeChat.exe"
                self.assertTrue(sender._find_window())

    def test_multiple_wechat_windows_fail_closed(self):
        sender = detection_sender([self.window(), self.window(hwnd=789)])
        self.assertFalse(sender._find_window())
        self.assertIn("ambiguous", sender._not_ready_reason)

    def test_uia_native_pid_mismatch_is_rejected(self):
        sender = detection_sender([self.window()])
        sender._native.window_info(456)["pid"] = 999
        self.assertFalse(sender._find_window())

    @patch.object(uia_sender.time, "monotonic", return_value=100)
    def test_startup_failure_recovers_after_retry_interval(self, clock):
        window = self.window()
        sender = detection_sender([window])
        sender._auto.root.children = []
        with patch.object(sender, "_find_window", wraps=sender._find_window) as find:
            self.assertFalse(sender._ensure_window())
            sender._auto.root.children = [window]
            clock.return_value = 101
            self.assertFalse(sender._ensure_window())
            self.assertEqual(find.call_count, 1)
            clock.return_value = 104
            self.assertTrue(sender._ensure_window())
            self.assertEqual(find.call_count, 2)
            self.assertTrue(sender._ready)

    def test_closed_window_clears_ready_and_contact_cache(self):
        sender = detection_sender([self.window()])
        self.assertTrue(sender._ensure_window())
        sender._last_contact = "old chat"
        sender._auto.root.children = []
        sender._native.window_info.side_effect = lambda _: None
        self.assertFalse(sender._ensure_window())
        self.assertFalse(sender._ready)
        self.assertEqual(sender._last_contact, "")
        self.assertEqual(sender._hwnd, 0)

    def test_reused_hwnd_for_foreign_process_is_not_trusted(self):
        sender = detection_sender([self.window()])
        self.assertTrue(sender._ensure_window())
        sender._native.process_image.return_value = r"C:\other.exe"
        self.assertFalse(sender._ensure_window())

    def test_context_initializes_com_and_rebuilds_control_per_call(self):
        sender = detection_sender([self.window()])
        with sender._uia_context() as initialized:
            self.assertTrue(initialized)
            self.assertTrue(sender._ensure_window())
        self.assertIsNone(sender._window)
        with sender._uia_context():
            self.assertTrue(sender._ensure_window())
            sender._auto.ControlFromHandle.assert_called_once_with(456)
        self.assertIsNone(sender._window)
        self.assertEqual(sender._auto.UIAutomationInitializerInThread.call_count, 2)

    def test_com_failure_does_not_send_keys(self):
        sender = detection_sender([self.window()])
        sender._auto.UIAutomationInitializerInThread.side_effect = RuntimeError("COM failed")
        self.assertFalse(sender.send_text("contact", "payload"))
        self.assertFalse(sender._ready)
        self.assertEqual(sender._auto.keys, [])

    def test_all_send_types_attempt_recovery_when_not_ready(self):
        for method in ("send_text", "send_image", "send_file"):
            with self.subTest(method=method):
                sender = detection_sender([self.window()])
                with patch.object(sender, "_ensure_window", return_value=False) as ensure, \
                        patch.object(uia_sender.os.path, "isfile", return_value=True):
                    self.assertFalse(getattr(sender, method)("contact", "payload"))
                ensure.assert_called_once()
                self.assertEqual(sender._auto.keys, [])

    @patch.object(uia_sender.time, "sleep")
    def test_activation_uses_selected_hwnd_and_checks_foreground(self, _sleep):
        sender = detection_sender([self.window()])
        self.assertTrue(sender._ensure_window())
        self.assertTrue(sender._activate())
        sender._native.activate.assert_called_once_with(456)
        sender._native.foreground.return_value = 999
        self.assertFalse(sender._activate())
        self.assertFalse(sender._switch_contact("contact"))
        self.assertEqual(sender._auto.keys, [])

    def test_failed_activation_aborts_all_sends_before_clipboard(self):
        for method in ("send_text", "send_image", "send_file"):
            with self.subTest(method=method):
                sender = detection_sender([self.window()])
                with patch.object(sender, "_activate", return_value=False), \
                        patch.object(uia_sender.os.path, "isfile", return_value=True), \
                        patch.object(sender, "_copy_image_to_clipboard") as image, \
                        patch.object(sender, "_copy_file_to_clipboard") as file:
                    self.assertFalse(getattr(sender, method)("contact", "payload"))
                image.assert_not_called()
                file.assert_not_called()
                self.assertEqual(sender._auto.keys, [])

    def test_child_enumeration_failure_cannot_look_like_ready_chat(self):
        sender = sender_with([[]])
        sender._window.GetChildren = Mock(side_effect=RuntimeError("stale control"))
        with self.assertRaisesRegex(RuntimeError, "stale control"):
            sender._route_surface_state()


    def test_empty_uia_surface_cannot_be_treated_as_ready_chat(self):
        sender = sender_with([[]])
        with self.assertRaisesRegex(RuntimeError, "no visible child windows"):
            sender._wait_for_chat_surface("contact")

    @patch.object(uia_sender.time, "sleep")
    def test_minimized_window_must_be_restored_before_activation_succeeds(self, _sleep):
        sender = detection_sender([self.window()])
        info = sender._native.window_info(456)
        info["iconic"] = True
        self.assertTrue(sender._ensure_window())
        self.assertFalse(sender._activate())
        sender._native.activate.side_effect = lambda hwnd: info.update(iconic=False)
        self.assertTrue(sender._activate())

    @patch.object(uia_sender.time, "monotonic", return_value=100)
    def test_missing_module_retry_is_throttled_without_key_input(self, _clock):
        sender = detection_sender([])
        sender._auto = None
        sender._next_window_retry = 103
        self.assertFalse(sender.send_text("contact", "payload"))
        self.assertFalse(sender._ready)


class NativeWindowsTests(unittest.TestCase):
    def native(self):
        native = object.__new__(uia_sender.NativeWindows)
        native.user32 = Mock()
        native.kernel32 = Mock()
        native.window_info = Mock(return_value={"iconic": False})
        native.kernel32.GetCurrentThreadId.return_value = 1
        native.user32.GetWindowThreadProcessId.return_value = 2
        native.user32.GetForegroundWindow.side_effect = [222, 0x100000123]
        return native

    def test_activation_preserves_large_handle_and_detaches_input(self):
        native = self.native()
        hwnd = 0x100000123
        self.assertTrue(native.activate(hwnd))
        native.user32.SetForegroundWindow.assert_called_once_with(hwnd)
        self.assertEqual(native.user32.AttachThreadInput.call_args_list,
                         [unittest.mock.call(1, 2, True), unittest.mock.call(1, 2, False)])
        native.user32.ShowWindow.assert_not_called()

    def test_activation_exception_still_detaches_input(self):
        native = self.native()
        native.user32.SetForegroundWindow.side_effect = RuntimeError("focus denied")
        with self.assertRaisesRegex(RuntimeError, "focus denied"):
            native.activate(456)
        native.user32.AttachThreadInput.assert_called_with(1, 2, False)

    def test_failed_input_attachment_is_not_detached(self):
        native = self.native()
        native.user32.AttachThreadInput.return_value = False
        native.activate(456)
        native.user32.AttachThreadInput.assert_called_once_with(1, 2, True)

    def test_only_minimized_window_is_restored(self):
        native = self.native()
        native.window_info.return_value = {"iconic": True}
        native.activate(456)
        native.user32.ShowWindow.assert_called_once_with(456, 9)

    def test_process_handle_is_closed_when_image_query_raises(self):
        native = self.native()
        native.kernel32.OpenProcess.return_value = 0x100000123
        native.kernel32.QueryFullProcessImageNameW.side_effect = RuntimeError("query failed")
        with self.assertRaisesRegex(RuntimeError, "query failed"):
            native.process_image(123)
        native.kernel32.CloseHandle.assert_called_once_with(0x100000123)


if __name__ == "__main__":
    unittest.main()
