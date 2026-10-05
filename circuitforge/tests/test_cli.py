"""Tests for the CLI."""

import unittest
import tempfile
import os
import json

from circuitforge.cli import main


class TestCLI(unittest.TestCase):

    def setUp(self):
        # Build a simple project file
        from circuitforge.core import build_circuit
        from circuitforge.sim.logic import register_logic_components_in_library
        from circuitforge.core import add_component, connect
        from circuitforge.io.serialize import project_to_json
        c = build_circuit("cli_test")
        register_logic_components_in_library(c.library)
        a = add_component(c, "LOGIC_INPUT", reference="A")
        g = add_component(c, "NOT", reference="G")
        o = add_component(c, "LOGIC_OUTPUT", reference="O")
        connect(c, a.ports[0], g.ports[0])
        connect(c, g.ports[1], o.ports[0])
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                          delete=False) as f:
            f.write(project_to_json(c))
            self.path = f.name

    def tearDown(self):
        os.unlink(self.path)

    def test_info(self):
        rc = main(["info", self.path])
        self.assertEqual(rc, 0)

    def test_validate(self):
        rc = main(["validate", self.path])
        self.assertEqual(rc, 0)

    def test_simulate_logic(self):
        rc = main(["simulate", self.path, "--logic", "--all-ones"])
        self.assertEqual(rc, 0)

    def test_export_schematic(self):
        rc = main(["export", self.path, "--format", "schematic"])
        self.assertEqual(rc, 0)

    def test_export_bom(self):
        rc = main(["export", self.path, "--format", "bom"])
        self.assertEqual(rc, 0)

    def test_gpu_info(self):
        rc = main(["gpu-info"])
        self.assertEqual(rc, 0)

    def test_no_args(self):
        rc = main([])
        self.assertEqual(rc, 0)

    def test_auto_design(self):
        rc = main(["auto-design", "--category", "adder", "--bits", "4"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()