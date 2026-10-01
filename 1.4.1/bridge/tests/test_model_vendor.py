"""Select bundled model wheels by ABI without touching installed Python packages."""
import os
import platform
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import builtin_model


class ModelVendorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bridge-model-vendor-")
        self.addCleanup(self.temp.cleanup)
        self.bridge = Path(self.temp.name)
        self.root = self.bridge / "vendor"
        self.root.mkdir()
        patches = [patch.object(builtin_model, "__file__", str(self.bridge / "builtin_model.py")),
                   patch.object(sys, "platform", "win32"), patch.object(sys, "maxsize", 2 ** 63 - 1),
                   patch.object(sys.implementation, "name", "cpython"),
                   patch.object(platform, "machine", return_value="AMD64")]
        for context in patches:
            context.start()
            self.addCleanup(context.stop)

    def test_python310_keeps_legacy_vendor_layout(self):
        with patch.object(sys, "version_info", (3, 10, 2)):
            self.assertEqual(builtin_model._model_vendor_path(), self.root)

    def test_python312_uses_separate_cp312_wheels(self):
        matching = self.root / "cp312-win_amd64"
        matching.mkdir()
        with patch.object(sys, "version_info", (3, 12, 12)):
            self.assertEqual(builtin_model._model_vendor_path(), matching)

    def test_explicit_versioned_directory_precedes_legacy_layout(self):
        matching = self.root / "cp310-win_amd64"
        matching.mkdir()
        with patch.object(sys, "version_info", (3, 10, 2)):
            self.assertEqual(builtin_model._model_vendor_path(), matching)

    def test_missing_cp312_never_falls_back_to_cp310(self):
        with patch.object(sys, "version_info", (3, 12, 12)):
            self.assertIsNone(builtin_model._model_vendor_path())

    def test_unsupported_version_uses_own_environment(self):
        (self.root / "cp312-win_amd64").mkdir()
        with patch.object(sys, "version_info", (3, 14, 0)):
            self.assertIsNone(builtin_model._model_vendor_path())

    def test_other_platform_architecture_and_implementation_skip_windows_wheels(self):
        (self.root / "cp312-win_amd64").mkdir()
        with patch.object(sys, "version_info", (3, 12, 12)):
            for context in (patch.object(sys, "platform", "linux"),
                            patch.object(sys, "maxsize", 2 ** 31 - 1),
                            patch.object(platform, "machine", return_value="ARM64"),
                            patch.object(sys.implementation, "name", "pypy")):
                with context:
                    self.assertIsNone(builtin_model._model_vendor_path())

    def test_sdk_import_sees_only_matching_bundle_and_does_not_duplicate_path(self):
        matching = self.root / "cp312-win_amd64"
        matching.mkdir()
        fake_sdk = types.ModuleType("pydantic_ai")
        with patch.object(sys, "version_info", (3, 12, 12)), patch.object(sys, "path", sys.path[:]), \
                patch.dict(sys.modules, {"pydantic_ai": fake_sdk}), patch.dict(os.environ):
            before = sys.path[:]
            self.assertIs(builtin_model.load_sdk(), fake_sdk)
            self.assertEqual(sys.path, [str(matching), *before])
            self.assertNotIn(str(self.root), sys.path)
            self.assertIs(builtin_model.load_sdk(), fake_sdk)
            self.assertEqual(sys.path.count(str(matching)), 1)

    def test_installed_sdk_remains_usable_without_compatible_bundle(self):
        fake_sdk = types.ModuleType("pydantic_ai")
        with patch.object(sys, "version_info", (3, 12, 12)), patch.object(sys, "path", sys.path[:]), \
                patch.dict(sys.modules, {"pydantic_ai": fake_sdk}), patch.dict(os.environ):
            before = sys.path[:]
            self.assertIs(builtin_model.load_sdk(), fake_sdk)
            self.assertEqual(sys.path, before)


if __name__ == "__main__":
    unittest.main()
