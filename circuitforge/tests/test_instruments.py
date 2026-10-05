"""Tests for virtual instruments."""

import unittest
import math

from circuitforge.instruments import VMM1, TINY_OSC, FND2, Measurement


class TestVMM1(unittest.TestCase):

    def test_dc_reading(self):
        vmm = VMM1()
        for i in range(10):
            vmm.sample("VOUT", i * 0.001, 3.3)
        m = vmm.read("VOUT")
        self.assertAlmostEqual(m.value, 3.3, places=1)
        self.assertEqual(m.unit, "V")
        self.assertEqual(m.instrument, "VMM-1")

    def test_noise_deterministic(self):
        vmm = VMM1()
        for i in range(5):
            vmm.sample("X", i, 1.0)
        m1 = vmm.read("X")
        m2 = vmm.read("X")
        # Noise is deterministic; same value twice
        self.assertEqual(m1.value, m2.value)

    def test_empty_buffer(self):
        vmm = VMM1()
        m = vmm.read("X")
        self.assertTrue(math.isnan(m.value))


class TestTINYOSC(unittest.TestCase):

    def test_dc_measurement(self):
        osc = TINY_OSC()
        for i in range(20):
            osc.sample(i * 20e-9, 3.3)
        m = osc.measure()
        # DC: V_pp = 0
        self.assertAlmostEqual(m.value, 0.0, places=5)
        # Mean should be ~3.3
        self.assertAlmostEqual(m.extras["v_mean"], 3.3, places=1)

    def test_peak_to_peak(self):
        osc = TINY_OSC()
        for i in range(200):
            t = i * 20e-9
            v = 2.5 + 1.0 * math.sin(2 * math.pi * 1e6 * t)
            osc.sample(t, v)
        m = osc.measure()
        # V_pp should be ~2.0
        self.assertAlmostEqual(m.value, 2.0, places=1)

    def test_8bit_quantization(self):
        osc = TINY_OSC()
        # Test quantization resolution
        for v in [-5.0, -1.0, 0.0, 1.0, 5.0]:
            osc.sample(0, v)
            osc.measure()  # this resets nothing actually
        osc.samples = [(0, 0.001), (1, 0.0)]  # sub-step values
        m = osc.measure()
        # Both samples should be quantized to 0
        self.assertEqual(m.samples[0], 0.0)


class TestFND2(unittest.TestCase):

    def test_1khz_signal(self):
        fnd = FND2(v_threshold=0.0)
        f0 = 1000.0  # 1 kHz
        # Sample 1 second at 100kHz
        n = 100_000
        for i in range(n):
            t = i * 1e-5
            v = math.sin(2 * math.pi * f0 * t)
            fnd.sample(t, v)
        m = fnd.measure()
        # 1% accuracy
        self.assertAlmostEqual(m.value, f0, delta=f0 * 0.02)

    def test_no_signal(self):
        fnd = FND2()
        fnd.sample(0, 0.0)
        fnd.sample(1, 0.0)
        m = fnd.measure()
        self.assertEqual(m.value, 0.0)


if __name__ == "__main__":
    unittest.main()