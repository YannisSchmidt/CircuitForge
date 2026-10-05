"""Tests for the core circuit model."""

import json
import unittest

from circuitforge.core import (
    build_circuit, add_component, connect, connect_ports, Ground,
    Library, ChipDefinition, ComponentSpec, ComponentKind, ModelAccuracy,
    PortSpec, PortDirection, PortKind, PARAM_R, PARAM_C, PARAM_VTH,
    register_primitive_specs, BUILTIN_PRIMITIVES,
    ResistorSpec, NmosSpec, VSourceDcSpec, VSourcePulseSpec, GroundSpec,
)
from circuitforge.core.ids import ComponentId, NetId, PortId
from circuitforge.exceptions import CircuitForgeError
from circuitforge.io.serialize import (
    project_to_json, project_from_json,
    spec_to_dict, spec_from_dict, library_to_dict, library_from_dict,
)


class TestIds(unittest.TestCase):

    def test_typed_id_equality(self):
        self.assertEqual(ComponentId(3), ComponentId(3))
        self.assertNotEqual(ComponentId(3), ComponentId(4))
        # Mixed: ComponentId vs NetId should be unequal
        self.assertNotEqual(ComponentId(3), NetId(3))
        # Hash differs for different types even with same int
        self.assertNotEqual(hash(ComponentId(3)), hash(NetId(3)))

    def test_id_acts_as_int(self):
        cid = ComponentId(42)
        self.assertEqual(int(cid), 42)
        self.assertEqual(cid.__index__(), 42)
        # IDs deliberately do NOT support arithmetic: they are typed
        # wrappers used as dict keys. This is to prevent accidental
        # mixing of unrelated ID spaces.
        with self.assertRaises(TypeError):
            _ = cid + 1
        # But they can be compared to int by value
        self.assertEqual(cid, 42)


class TestLibrary(unittest.TestCase):

    def test_register_primitive(self):
        lib = Library("t")
        spec = ResistorSpec()
        lib.register_primitive(spec)
        self.assertTrue(lib.has_primitive("RESISTOR"))
        self.assertIs(lib.get_primitive("RESISTOR"), spec)

    def test_register_duplicate_raises(self):
        lib = Library("t")
        lib.register_primitive(ResistorSpec())
        with self.assertRaises(ValueError):
            lib.register_primitive(ResistorSpec())

    def test_primitives_registered(self):
        lib = Library("t")
        register_primitive_specs(lib)
        for s in ("RESISTOR", "CAPACITOR", "INDUCTOR", "DIODE",
                  "NMOS", "PMOS", "BJT_NPN",
                  "VSRC_DC", "VSRC_AC", "VSRC_PULSE", "ISRC_DC",
                  "SWITCH", "GROUND"):
            self.assertTrue(lib.has_primitive(s), f"missing {s}")


class TestModelAccuracy(unittest.TestCase):

    def test_resistor_accuracy(self):
        s = ResistorSpec()
        self.assertEqual(s.model_accuracy["logic"], ModelAccuracy.NOT_MODELED)
        self.assertEqual(s.model_accuracy["electrical"], ModelAccuracy.APPROXIMATED)
        self.assertEqual(s.model_accuracy["detailed"], ModelAccuracy.APPROXIMATED)
        self.assertEqual(s.model_accuracy["thermal"], ModelAccuracy.APPROXIMATED)

    def test_nmos_accuracy(self):
        s = NmosSpec()
        self.assertEqual(s.model_accuracy["electrical"], ModelAccuracy.APPROXIMATED)
        self.assertEqual(s.model_accuracy["detailed"], ModelAccuracy.APPROXIMATED)

    def test_accuracy_report_format(self):
        s = ResistorSpec()
        rep = s.accuracy_report()
        self.assertIn("MODEL ACCURACY", rep)
        self.assertIn("logic", rep)
        self.assertIn("electrical", rep)


class TestCircuitBuild(unittest.TestCase):

    def test_rc_circuit_round_trip(self):
        c = build_circuit("rc")
        r = add_component(c, "RESISTOR", reference="R1", r=10e3)
        cap = add_component(c, "CAPACITOR", reference="C1", c=1e-9)
        gnd = Ground(c)
        connect(c, r.ports[0], cap.ports[0])
        connect(c, r.ports[1], gnd.ports[0])
        connect(c, cap.ports[1], gnd.ports[0])
        issues = c.check_integrity()
        self.assertEqual(issues, [], f"unexpected issues: {issues}")
        self.assertEqual(c.bom(), {"RESISTOR": 1, "CAPACITOR": 1, "GROUND": 1})

    def test_connect_merges_nets(self):
        c = build_circuit("m")
        a = add_component(c, "RESISTOR", reference="R1", r=1e3)
        b = add_component(c, "RESISTOR", reference="R2", r=1e3)
        d = add_component(c, "RESISTOR", reference="R3", r=1e3)
        # a.p0 - b.p0 in net N1; b.p1 - d.p0 in net N2; then connect a.p0 - b.p1 should merge
        n1 = connect(c, a.ports[0], b.ports[0])
        n2 = connect(c, b.ports[1], d.ports[0])
        self.assertNotEqual(n1, n2)
        n3 = connect(c, a.ports[0], b.ports[1])
        # After merge, all four ports are in one net
        net = c.nets[NetId(n1)]
        self.assertIn(a.ports[0], net.ports)
        self.assertIn(b.ports[0], net.ports)
        self.assertIn(b.ports[1], net.ports)
        self.assertIn(d.ports[0], net.ports)
        # d.ports[0] and d.ports[1] should NOT be merged (only one of them)
        self.assertNotIn(d.ports[1], net.ports)

    def test_param_validation(self):
        c = build_circuit("t")
        # min=0 for resistance; negative should raise
        with self.assertRaises(ValueError):
            add_component(c, "RESISTOR", r=-1.0)

    def test_dangling_port_detected(self):
        c = build_circuit("dang")
        r = add_component(c, "RESISTOR", reference="R1", r=1e3)
        # Don't connect anything
        issues = c.check_integrity()
        self.assertTrue(any("dangling" in s for s in issues))

    def test_fingerprint_stable_under_param_reorder(self):
        c1 = build_circuit("a")
        c2 = build_circuit("a")
        r1 = add_component(c1, "RESISTOR", reference="R1", r=1e3)
        r2 = add_component(c2, "RESISTOR", reference="R1", r=1e3)
        self.assertEqual(c1.fingerprint(), c2.fingerprint())

    def test_fingerprint_changes_with_params(self):
        c1 = build_circuit("a")
        c2 = build_circuit("a")
        add_component(c1, "RESISTOR", reference="R1", r=1e3)
        add_component(c2, "RESISTOR", reference="R1", r=2e3)
        self.assertNotEqual(c1.fingerprint(), c2.fingerprint())


class TestComponentSpecConstraints(unittest.TestCase):

    def test_duplicate_param_raises(self):
        s = ResistorSpec()
        with self.assertRaises(ValueError):
            s.add_param(PARAM_R, 1.0)

    def test_duplicate_port_raises(self):
        s = ResistorSpec()
        with self.assertRaises(ValueError):
            s.add_port("a", direction=PortDirection.NONE)

    def test_port_index_lookup(self):
        s = NmosSpec()
        self.assertEqual(s.port_index("g"), 1)
        with self.assertRaises(KeyError):
            s.port_index("not_a_port")

    def test_param_default_and_validation(self):
        s = ResistorSpec()
        self.assertEqual(s.get_param_default("r"), 1e3)
        p = s.parameters["r"]
        self.assertEqual(p.validate(2e3), 2e3)
        with self.assertRaises(ValueError):
            p.validate(-1.0)


class TestGlobalNets(unittest.TestCase):

    def test_ground_creates_global_net(self):
        c = build_circuit("g")
        g = Ground(c)
        nets_with_gnd = [n for n in c.nets.values() if n.name == "GND"]
        self.assertEqual(len(nets_with_gnd), 1)
        self.assertTrue(nets_with_gnd[0].is_global)
        self.assertIn(g.ports[0], nets_with_gnd[0].ports)

    def test_nmos_body_connected_to_gnd(self):
        c = build_circuit("g")
        gnd = Ground(c)
        n = add_component(c, "NMOS", reference="M1", kn=50e-6)
        body_pid = n.ports[3]  # 'b'
        self.assertEqual(
            c.ports[PortId(int(body_pid))].net,
            c.ports[PortId(int(gnd.ports[0]))].net,
        )


class TestSerialization(unittest.TestCase):

    def test_spec_round_trip(self):
        s = ResistorSpec()
        d = spec_to_dict(s)
        s2 = spec_from_dict(d)
        self.assertEqual(s2.name, s.name)
        self.assertEqual(s2.ports[0].name, s.ports[0].name)
        self.assertEqual(s2.parameters["r"].default, s.parameters["r"].default)
        self.assertEqual(s2.model_accuracy["electrical"], s.model_accuracy["electrical"])

    def test_project_round_trip(self):
        c = build_circuit("rc")
        r = add_component(c, "RESISTOR", reference="R1", r=10e3)
        cap = add_component(c, "CAPACITOR", reference="C1", c=1e-9)
        gnd = Ground(c)
        connect(c, r.ports[0], cap.ports[0])
        connect(c, r.ports[1], gnd.ports[0])
        connect(c, cap.ports[1], gnd.ports[0])
        s = project_to_json(c)
        c2 = project_from_json(s)
        self.assertEqual(c.fingerprint(), c2.fingerprint())
        self.assertEqual(c.bom(), c2.bom())

    def test_project_round_trip_with_source(self):
        c = build_circuit("inv")
        v = add_component(c, "VSRC_DC", reference="V1", vdc=3.3)
        nmos = add_component(c, "NMOS", reference="M1", kn=50e-6)
        pmos = add_component(c, "PMOS", reference="M2", kp=20e-6, vth=-0.7)
        gnd = Ground(c)
        # V1+ -> pmos.s and nmos.d
        connect(c, v.ports[0], pmos.ports[2])  # pmos.s
        connect(c, v.ports[0], nmos.ports[0])  # nmos.d
        # gates together
        connect(c, pmos.ports[1], nmos.ports[1])  # g
        # sources/grounds
        connect(c, nmos.ports[2], gnd.ports[0])  # nmos.s
        # pmos body is auto-attached to VDD (default), so create VDD net manually
        vdd = add_component(c, "VSRC_DC", reference="VDD", vdc=3.3)
        connect(c, vdd.ports[0], v.ports[0])  # share rail
        connect(c, vdd.ports[1], gnd.ports[0])
        connect(c, pmos.ports[3], vdd.ports[0])  # pmos.b
        s = project_to_json(c)
        c2 = project_from_json(s)
        self.assertEqual(c.fingerprint(), c2.fingerprint())

    def test_unknown_schema_raises(self):
        c = build_circuit("x")
        s = project_to_json(c)
        # mangle schema
        d = json.loads(s)
        d["schema"] = 99999
        bad = json.dumps(d)
        with self.assertRaises(Exception):
            project_from_json(bad)


if __name__ == "__main__":
    unittest.main()
