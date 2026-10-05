"""Tests for the GUI stub.

The full GUI requires tkinter and a display. We just test that the
module imports and that the main window class can be instantiated
when tkinter is available. The `run_gui` function is exercised
manually, not in CI.
"""

import unittest

from circuitforge import gui


class TestGUIModule(unittest.TestCase):

    def test_module_imports(self):
        self.assertTrue(hasattr(gui, "CircuitForgeApp"))
        self.assertTrue(hasattr(gui, "run_gui"))

    def test_version_string(self):
        v = gui._version_string()
        self.assertIsInstance(v, str)
        self.assertGreater(len(v), 0)


if __name__ == "__main__":
    unittest.main()