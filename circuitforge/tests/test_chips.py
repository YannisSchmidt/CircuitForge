"""Tests for the hierarchical chip system."""

import unittest

from circuitforge.chips import (
    save_as_chip, instantiate_chip, unfold_chip, unfold_all,
    list_chip_instances, ChipInstance,
)
from circuitforge.core import build_circuit, add_component, connect, Ground
from circuitforge.core.ids import PortId


def _make_simple_chip():
    """Build a small chip: a NAND-like structure with public ports INA, INB, Y."""
    c = build_circuit("src")
    a = add_component(c, "VSRC_DC", reference="INA", vdc=0.0)
    b = add_component(c, "VSRC_DC", reference="INB", vdc=0.0)
    m1 = add_component(c, "NMOS", reference="M1", kn=50e-6)
    m2 = add_component(c, "NMOS", reference="M2", kn=50e-6)
    g = Ground(c)
    connect(c, a.ports[0], m1.ports[1])
    connect(c, b.ports[0], m2.ports[1])
    connect(c, a.ports[1], g.ports[0])
    connect(c, b.ports[1], g.ports[0])
    connect(c, m1.ports[2], g.ports[0])
    connect(c, m2.ports[2], g.ports[0])
    connect(c, m1.ports[0], m2.ports[0])
    c.nets[c.ports[PortId(int(m1.ports[0]))].net].name = "Y"
    c.nets[c.ports[PortId(int(a.ports[0]))].net].name = "INA"
    c.nets[c.ports[PortId(int(b.ports[0]))].net].name = "INB"
    return c, a, b, m1


class TestChipRegistration(unittest.TestCase):

    def test_save_and_lookup(self):
        c, a, b, m1 = _make_simple_chip()
        chip = save_as_chip(c, c.library, "MY_NAND",
                            port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                        m1.ports[0]: "Y"},
                            description="A NAND built from two NMOS")
        self.assertIn("MY_NAND", c.library.list_chips())
        self.assertIn("MY_NAND", c.library.list_primitives())
        # Spec should have the right ports
        spec = c.library.get_primitive("MY_NAND")
        self.assertEqual([p.name for p in spec.ports], ["INA", "INB", "Y"])


class TestChipInstantiation(unittest.TestCase):

    def test_instantiate(self):
        c, a, b, m1 = _make_simple_chip()
        save_as_chip(c, c.library, "MY_NAND",
                     port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                 m1.ports[0]: "Y"})
        parent = build_circuit("parent")
        inst = instantiate_chip(parent, c.library, "MY_NAND", reference="U1")
        self.assertEqual(len(parent), 1)
        self.assertEqual(parent.bom()["MY_NAND"], 1)
        self.assertEqual(inst.reference, "U1")
        self.assertEqual(len(inst.ports), 3)  # INA, INB, Y

    def test_instantiate_unknown_chip_raises(self):
        parent = build_circuit("parent")
        with self.assertRaises(Exception):
            instantiate_chip(parent, parent.library, "DOES_NOT_EXIST")

    def test_instantiate_with_port_mapping(self):
        c, a, b, m1 = _make_simple_chip()
        save_as_chip(c, c.library, "MY_NAND",
                     port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                 m1.ports[0]: "Y"})
        parent = build_circuit("parent")
        ina = parent.create_net(name="A")
        inst = instantiate_chip(parent, c.library, "MY_NAND", reference="U1",
                                port_net_mapping={"INA": ina})
        # Check that the INA port of the chip is on the A net
        from circuitforge.core.ids import NetId
        self.assertEqual(parent.ports[PortId(int(inst.ports[0]))].net, NetId(ina))


class TestChipUnfold(unittest.TestCase):

    def test_unfold_replaces_chip_with_components(self):
        c, a, b, m1 = _make_simple_chip()
        save_as_chip(c, c.library, "MY_NAND",
                     port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                 m1.ports[0]: "Y"})
        parent = build_circuit("parent")
        inst = instantiate_chip(parent, c.library, "MY_NAND", reference="U1")
        # Connect chip ports to parent nets
        spec = parent.library.get_primitive("MY_NAND")
        ina_net = parent.create_net(name="PA")
        inb_net = parent.create_net(name="PB")
        y_net = parent.create_net(name="PY")
        for i, pspec in enumerate(spec.ports):
            pid = inst.ports[i]
            if pspec.name == "INA":
                parent._attach_to_net(pid, ina_net)
            elif pspec.name == "INB":
                parent._attach_to_net(pid, inb_net)
            elif pspec.name == "Y":
                parent._attach_to_net(pid, y_net)
        # Unfold
        unfolded = unfold_chip(parent, c.library, "MY_NAND", inst.id)
        # The chip should be gone, replaced by its internal components
        self.assertEqual(len(unfolded), 5)  # 2 VSRC + 2 NMOS + 1 GROUND
        self.assertNotIn("MY_NAND", unfolded.bom())
        self.assertEqual(unfolded.bom().get("VSRC_DC", 0), 2)
        self.assertEqual(unfolded.bom().get("NMOS", 0), 2)

    def test_unfold_preserves_connections(self):
        c, a, b, m1 = _make_simple_chip()
        save_as_chip(c, c.library, "MY_NAND",
                     port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                 m1.ports[0]: "Y"})
        parent = build_circuit("parent")
        inst = instantiate_chip(parent, c.library, "MY_NAND", reference="U1")
        spec = parent.library.get_primitive("MY_NAND")
        ina_net = parent.create_net(name="PA")
        inb_net = parent.create_net(name="PB")
        y_net = parent.create_net(name="PY")
        for i, pspec in enumerate(spec.ports):
            pid = inst.ports[i]
            if pspec.name == "INA":
                parent._attach_to_net(pid, ina_net)
            elif pspec.name == "INB":
                parent._attach_to_net(pid, inb_net)
            elif pspec.name == "Y":
                parent._attach_to_net(pid, y_net)
        unfolded = unfold_chip(parent, c.library, "MY_NAND", inst.id)
        # The PA net in the parent should now have ports (one of the
        # unfolded VSRC's p terminals)
        pa_net = None
        for nid, n in unfolded.nets.items():
            if n.name == "PA":
                pa_net = nid
                break
        self.assertIsNotNone(pa_net)
        self.assertGreater(len(unfolded.nets[pa_net].ports), 0)


class TestChipListInstances(unittest.TestCase):

    def test_list_empty(self):
        c = build_circuit("empty")
        self.assertEqual(list_chip_instances(c), [])

    def test_list_with_chip(self):
        c, a, b, m1 = _make_simple_chip()
        save_as_chip(c, c.library, "MY_NAND",
                     port_names={a.ports[0]: "INA", b.ports[0]: "INB",
                                 m1.ports[0]: "Y"})
        parent = build_circuit("parent")
        inst = instantiate_chip(parent, c.library, "MY_NAND", reference="U1")
        instances = list_chip_instances(parent)
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0].chip_name, "MY_NAND")
        self.assertEqual(instances[0].reference, "U1")


if __name__ == "__main__":
    unittest.main()
