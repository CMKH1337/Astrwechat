"""Startup diagnostics use the actual Electron JSON handler, without network/UI calls."""
import importlib.util
import io
import json
import logging
import os
import threading
import subprocess
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import quote


BRIDGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE))


class StartupDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.root = logging.getLogger()
        previous_handlers, previous_level = self.root.handlers[:], self.root.level
        self.addCleanup(setattr, self.root, "handlers", previous_handlers)
        self.addCleanup(self.root.setLevel, previous_level)
        self.root.handlers = []
        self.stdout = io.StringIO()
        self.config = types.SimpleNamespace(
            ACCESS_TOKEN="local-access-secret", OB_TOKEN="selected-ob-secret",
            BOT_BACKEND="builtin", OB_LABEL="内置模型", OB_URL="",
            WE_FLOW_BASE_URL="http://127.0.0.1:9",
            config={"builtin_api_key": "sk-test-private/key+汉字", "kourichat_ob_token": "inactive-secret"},
            BUILTIN_CONFIG={"builtin_api_key": "sk-test-private/key+汉字"},
        )
        spec = importlib.util.spec_from_file_location("startup_test_state", BRIDGE / "state.py")
        self.state = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.state)
        self.state.running = True
        self.state.paused.set()
        self.state.sender_instance = object()
        self.constructor = Mock()
        self.requests = types.SimpleNamespace(get=Mock(side_effect=AssertionError("No network expected")))
        modules = {
            "config": self.config, "state": self.state, "requests": self.requests,
            "senders": types.SimpleNamespace(create_sender=Mock()),
            "ob_client": types.SimpleNamespace(_run_ob_client=Mock()),
            "bridge_core": types.SimpleNamespace(WeFlowBridge=self.constructor),
        }
        spec = importlib.util.spec_from_file_location("startup_test_main", BRIDGE / "main.py")
        self.main = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules), patch("sys.stdout", self.stdout), patch("sys.stderr", io.StringIO()):
            spec.loader.exec_module(self.main)
        self.tmp = tempfile.TemporaryDirectory(prefix="bridge-startup-test-")
        self.addCleanup(self.tmp.cleanup)
        self.log_path = Path(self.tmp.name) / "bridge.log"
        handler = logging.FileHandler(self.log_path, encoding="utf-8")
        self.addCleanup(handler.close)
        handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        self.root.addHandler(handler)
        self.main.release_instance_lock = Mock()

    def fail_start(self, error):
        self.constructor.side_effect = error
        fake_ctypes = types.SimpleNamespace(windll=types.SimpleNamespace(ole32=types.SimpleNamespace(CoInitialize=Mock())))
        with patch("sys.stdout", self.stdout), patch.dict(sys.modules, {"ctypes": fake_ctypes}):
            self.main._bridge_loop()
        frames = [json.loads(line) for line in self.stdout.getvalue().splitlines()]
        logs = [frame["data"]["msg"] for frame in frames if frame["type"] == "log"]
        self.requests.get.assert_not_called()
        self.main.release_instance_lock.assert_called_once_with()
        self.assertFalse(self.state.running)
        self.assertFalse(self.state._ob_ws_ready.is_set())
        self.assertIsNone(self.state.bridge_instance)
        self.assertEqual(self.state.ob_state, "error")
        self.assertEqual(frames[-1]["type"], "status")
        self.assertEqual(frames[-1]["data"]["ob_error"], self.state.ob_error)
        return "\n".join(logs)

    def test_builtin_ready_workflow_log_follows_successful_initialization(self):
        bridge = Mock()
        self.constructor.return_value = bridge
        self.state.running = False
        with patch('sys.stdout', self.stdout), \
                patch.object(self.main.requests, 'get', return_value=types.SimpleNamespace(status_code=200)):
            self.main._bridge_loop()
        messages = [json.loads(line) for line in self.stdout.getvalue().splitlines()]
        logs = [item['data']['msg'] for item in messages if item['type'] == 'log']
        self.assertIn('[内置模型] 已就绪', logs)
        self.assertLess(logs.index('WeFlow API 连接正常'), logs.index('[内置模型] 已就绪'))
        bridge.close.assert_called_once()

    def test_missing_module_name_and_traceback_reach_json_file_and_status(self):
        logs = self.fail_start(ModuleNotFoundError("No module named 'pydantic_ai'", name="pydantic_ai"))
        self.assertIn("ModuleNotFoundError: No module named 'pydantic_ai'", logs)
        self.assertIn("[E_MODEL_DEPENDENCY]", logs)
        self.assertNotIn("[内置模型] 已就绪", logs)
        self.assertIn("缺失模块：pydantic_ai", logs)
        self.assertIn("Traceback (most recent call last):", logs)
        self.assertIn("_bridge_loop", logs)
        self.assertIn("pydantic_ai", self.state.ob_error)
        saved = self.log_path.read_text(encoding="utf-8")
        self.assertIn("缺失模块：pydantic_ai", saved)
        self.assertIn("Traceback (most recent call last):", saved)

    def test_missing_transitive_module_name_survives(self):
        logs = self.fail_start(ModuleNotFoundError("No module named 'pydantic_core._pydantic_core'",
                                                  name="pydantic_core._pydantic_core"))
        self.assertIn("缺失模块：pydantic_core._pydantic_core", logs)

    def test_runtime_and_vendor_location_are_reported(self):
        logs = self.fail_start(ImportError("DLL load failed"))
        self.assertIn("DLL load failed", logs)
        self.assertIn(sys.executable, logs)
        self.assertIn(sys.version.split()[0], logs)
        self.assertIn(str(BRIDGE / "vendor"), logs)
        self.assertIn("CPython 3.10", logs)
        self.assertIn("bridge/requirements.txt", logs)

    def test_missing_module_without_name_still_reports_message(self):
        logs = self.fail_start(ModuleNotFoundError("missing optional module"))
        self.assertIn("ModuleNotFoundError: missing optional module", logs)
        self.assertNotIn("缺失模块：None", logs)

    def test_configuration_error_is_actionable(self):
        logs = self.fail_start(ValueError("请填写模型名称和有效的 API Key"))
        self.assertIn("[E_MODEL_CONFIG]", logs)
        self.assertIn("ValueError: 请填写模型名称和有效的 API Key", logs)
        self.assertIn("请填写模型名称", self.state.ob_error)
        self.assertNotIn("请检查安装包", logs)

    def test_chained_errors_redact_active_inactive_and_encoded_credentials(self):
        secrets = [self.config.ACCESS_TOKEN, self.config.OB_TOKEN, *self.config.config.values()]
        variants = [variant for secret in secrets for variant in
                    (secret, repr(secret)[1:-1], json.dumps(secret, ensure_ascii=True)[1:-1], quote(secret, safe=""))]
        try:
            try:
                raise ModuleNotFoundError("missing-dependency " + " ".join(variants), name="missing-dependency")
            except ModuleNotFoundError as cause:
                raise RuntimeError("model initialization failed " + secrets[2]) from cause
        except RuntimeError as error:
            logs = self.fail_start(error)
        self.assertIn("missing-dependency", logs)
        self.assertIn("direct cause", logs)
        self.assertIn("[REDACTED]", logs)
        outputs = (logs, self.state.ob_error, self.log_path.read_text(encoding="utf-8"))
        for output in outputs:
            for secret in variants:
                self.assertNotIn(secret, output)

    def test_non_builtin_backend_retains_diagnostics_without_model_advice(self):
        self.config.BOT_BACKEND = "astrbot"
        logs = self.fail_start(ModuleNotFoundError("No module named 'example'", name="example"))
        self.assertIn("[E_BRIDGE_INIT]", logs)
        self.assertIn("缺失模块：example", logs)
        self.assertNotIn("请检查安装包", logs)

    def test_main_thread_exception_reports_chained_traceback_and_process_context(self):
        secret = self.config.ACCESS_TOKEN
        self.main._last_action = "start"
        self.main._process_stage = "初始化微信发送器"
        try:
            try:
                raise ImportError("missing native dependency " + secret)
            except ImportError as cause:
                raise RuntimeError("sender initialization failed") from cause
        except RuntimeError as error:
            with patch("sys.stdout", self.stdout):
                self.main._main_exception_hook(type(error), error, error.__traceback__)
        frames = [json.loads(line) for line in self.stdout.getvalue().splitlines()]
        text = "\n".join(item["data"]["msg"] for item in frames)
        for expected in ("主线程未捕获异常", "Traceback", "direct cause", "最后命令=start", "初始化微信发送器", "PID=", "活动线程=", "[REDACTED]"):
            self.assertIn(expected, text)
        self.assertNotIn(secret, text)
        saved = self.log_path.read_text(encoding="utf-8")
        self.assertIn("sender initialization failed", saved)
        self.assertNotIn(secret, saved)

    def test_thread_exception_hook_names_the_failing_thread(self):
        error = ValueError("worker failed " + self.config.OB_TOKEN)
        args = types.SimpleNamespace(exc_type=ValueError, exc_value=error, exc_traceback=None,
                                     thread=types.SimpleNamespace(name="ob11-client-7"))
        with patch("sys.stdout", self.stdout):
            self.main._thread_exception_hook(args)
        text = self.stdout.getvalue()
        self.assertIn("后台线程未捕获异常", text)
        self.assertIn("ob11-client-7", text)
        self.assertIn("[REDACTED]", text)
        self.assertNotIn(self.config.OB_TOKEN, text)

    def test_early_import_diagnostics_redact_config_before_config_module_is_loaded(self):
        path = Path(self.tmp.name) / "early-config.json"
        secret = "early-private/key+汉字"
        path.write_text(json.dumps({"builtin_api_key": secret}), encoding="utf-8")
        with patch.dict(self.main.__dict__, {"cfg": None, "log": None}), \
                patch.dict(os.environ, {"WEFLOW_BRIDGE_CONFIG": str(path)}), \
                patch("sys.stderr", io.StringIO()) as stderr:
            self.main._diagnostic_log("error", "import failed " + secret + " " + quote(secret, safe=""))
            text = stderr.getvalue()
        self.assertIn("import failed", text)
        self.assertIn("[REDACTED]", text)
        self.assertNotIn(secret, text)
        self.assertNotIn(quote(secret, safe=""), text)

    def test_native_fault_handler_and_exception_hooks_install_before_imports(self):
        fake_fault = types.SimpleNamespace(enable=Mock())
        with patch.dict(sys.modules, {"faulthandler": fake_fault}), \
                patch("sys.excepthook"), patch("threading.excepthook"), \
                patch("sys.stdout", self.stdout), patch("sys.stderr", io.StringIO()) as stderr:
            self.main._install_process_diagnostics()
            self.assertIs(sys.excepthook, self.main._main_exception_hook)
            self.assertIs(threading.excepthook, self.main._thread_exception_hook)
            fake_fault.enable.assert_called_once_with(file=stderr, all_threads=True)
        self.assertIn("Python入口", self.stdout.getvalue())

    def test_broken_stdout_still_preserves_redacted_exception_in_file(self):
        output = io.StringIO()
        output.close()
        error = RuntimeError("parent pipe closed " + self.config.ACCESS_TOKEN)
        with patch("sys.stdout", output):
            self.main._main_exception_hook(type(error), error, None)
        saved = self.log_path.read_text(encoding="utf-8")
        self.assertIn("parent pipe closed [REDACTED]", saved)
        self.assertNotIn(self.config.ACCESS_TOKEN, saved)

    def test_logging_failure_fallback_still_redacts_traceback(self):
        error = RuntimeError("fallback failure " + self.config.ACCESS_TOKEN)
        with patch.object(self.main, "_report_uncaught_exception", side_effect=OSError("handler failed")), \
                patch("sys.stderr", io.StringIO()) as output:
            self.main._main_exception_hook(type(error), error, None)
        self.assertIn("fallback failure [REDACTED]", output.getvalue())
        self.assertNotIn(self.config.ACCESS_TOKEN, output.getvalue())

    def test_real_python_entrypoint_reports_a_command_crash_and_persists_traceback(self):
        runtime = Path(self.tmp.name) / "real-child"
        runtime.mkdir()
        defaults = json.loads((BRIDGE.parent / "shared" / "bridge-default-config.json").read_text(encoding="utf-8"))
        config_path = runtime / "config.json"
        config_path.write_text(json.dumps(defaults), encoding="utf-8")
        env = {**os.environ, "WEFLOW_BRIDGE_CONFIG": str(config_path), "PYTHONFAULTHANDLER": "1",
               "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        result = subprocess.run([sys.executable, "-B", str(BRIDGE / "main.py")], input="[]\n",
                                capture_output=True, encoding="utf-8", env=env, cwd=runtime,
                                timeout=15, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("Python入口", result.stderr)
        self.assertIn("主线程未捕获异常", result.stdout)
        self.assertIn("AttributeError", result.stdout)
        saved = (runtime / "bridge.log").read_text(encoding="utf-8")
        self.assertIn("_stdin_loop", saved)
        self.assertIn("Traceback", saved)
        self.assertIn("thread=MainThread", saved)



if __name__ == "__main__":
    unittest.main()
