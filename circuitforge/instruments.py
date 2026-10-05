"""
Virtual instruments (section 13 of the spec).

This module defines three instruments used to interact with a
running simulation:

* ``VMM1`` (voltmeter) — measures the DC / instantaneous voltage on
  a single net. With a probe list, multi-channel acquisition is
  supported.
* ``TINY_OSC`` (oscilloscope) — captures a transient waveform on a
  net over a time window.
* ``FND2`` (frequency counter) — measures the dominant frequency
  on a net via zero-crossing counting.

Each instrument is configured with a clock source and returns a
``Measurement`` object containing raw samples, derived metrics, and
the instrument's accuracy class.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict, Any
import math
import time as _time


@dataclass
class Measurement:
    """A measurement produced by an instrument."""
    instrument: str
    target: str
    samples: List[float] = field(default_factory=list)
    timestamps: List[float] = field(default_factory=list)
    value: float = 0.0
    unit: str = ""
    accuracy: str = "REALISTIC"
    extras: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> str:
        return (
            f"{self.instrument}({self.target}) = {self.value:.6g} {self.unit}"
            f"  accuracy={self.accuracy}  n_samples={len(self.samples)}"
        )


class VMM1:
    """
    Virtual Multi-Meter, model VMM-1.

    Measures DC voltage by averaging the last N samples, with a
    configurable integration time. Reports a 0.1% accuracy class.

    A probe is a (net_name, sample_callback) pair. The instrument
    pulls samples via the callback to remain decoupled from the
    simulator's data structures.
    """
    INSTRUMENT = "VMM-1"
    ACCURACY = "REALISTIC"

    def __init__(self, integration_time: float = 0.01):
        self.integration_time = integration_time
        self.buffer: Dict[str, List[Tuple[float, float]]] = {}

    def sample(self, target: str, t: float, v: float) -> None:
        """Add one sample (t, v) to the buffer for `target`."""
        self.buffer.setdefault(target, []).append((t, v))

    def read(self, target: str) -> Measurement:
        if target not in self.buffer or not self.buffer[target]:
            return Measurement(instrument=self.INSTRUMENT, target=target,
                                value=float("nan"), unit="V",
                                accuracy=self.ACCURACY)
        # Average the samples within the integration window
        t_end = self.buffer[target][-1][0]
        t_start = t_end - self.integration_time
        window = [v for t, v in self.buffer[target] if t >= t_start]
        if not window:
            window = [v for _, v in self.buffer[target][-1:]]
        v_avg = sum(window) / len(window)
        # Add a small noise model: 0.1% of full scale (assumed 5V)
        noise = (5.0 * 0.001) * (hash(target) % 7 - 3) / 3  # deterministic, ±0.1% of 5V
        v_meas = v_avg + noise
        return Measurement(
            instrument=self.INSTRUMENT, target=target,
            samples=[v for _, v in self.buffer[target]],
            timestamps=[t for t, _ in self.buffer[target]],
            value=v_meas, unit="V", accuracy=self.ACCURACY,
            extras={"window_samples": len(window), "integration_time": self.integration_time},
        )

    def reset(self) -> None:
        self.buffer.clear()


class TINY_OSC:
    """
    Tiny oscilloscope model TINY-OSC.

    Captures a window of samples on a single channel and reports
    the peak-to-peak amplitude, the mean, and the RMS value. 50 MHz
    sample rate (50 ns period), 8-bit vertical resolution.
    """
    INSTRUMENT = "TINY-OSC"
    ACCURACY = "REALISTIC"
    SAMPLE_PERIOD = 20e-9  # 50 MHz
    V_FS = 5.0  # full-scale voltage
    RESOLUTION_BITS = 8

    def __init__(self, sample_rate: float = 50e6, v_full_scale: float = 5.0):
        self.sample_period = 1.0 / sample_rate
        self.v_full_scale = v_full_scale
        self.samples: List[Tuple[float, float]] = []

    def sample(self, t: float, v: float) -> None:
        self.samples.append((t, v))

    def quantize(self, v: float) -> float:
        """8-bit quantize: round to nearest step."""
        step = self.v_full_scale / (1 << self.RESOLUTION_BITS)
        return round(v / step) * step

    def measure(self) -> Measurement:
        if not self.samples:
            return Measurement(instrument=self.INSTRUMENT, target="",
                                value=0.0, unit="V", accuracy=self.ACCURACY)
        vs = [v for _, v in self.samples]
        # Quantize samples
        qs = [self.quantize(v) for v in vs]
        v_max = max(qs)
        v_min = min(qs)
        v_pp = v_max - v_min
        v_mean = sum(qs) / len(qs)
        v_rms = math.sqrt(sum(v * v for v in qs) / len(qs))
        return Measurement(
            instrument=self.INSTRUMENT, target="",
            samples=qs, timestamps=[t for t, _ in self.samples],
            value=v_pp, unit="V_pp", accuracy=self.ACCURACY,
            extras={"v_min": v_min, "v_max": v_max, "v_mean": v_mean,
                    "v_rms": v_rms, "n_samples": len(qs)},
        )

    def reset(self) -> None:
        self.samples.clear()


class FND2:
    """
    Frequency counter, model FND-2.

    Measures the dominant frequency on a channel via zero-crossing
    counting on a 1-second window by default. Reports accuracy class
    REALISTIC.
    """
    INSTRUMENT = "FND-2"
    ACCURACY = "REALISTIC"
    DEFAULT_GATE_TIME = 1.0  # 1 second

    def __init__(self, gate_time: float = DEFAULT_GATE_TIME,
                 v_threshold: float = 2.5):
        self.gate_time = gate_time
        self.v_threshold = v_threshold
        self.samples: List[Tuple[float, float]] = []

    def sample(self, t: float, v: float) -> None:
        self.samples.append((t, v))

    def measure(self) -> Measurement:
        if len(self.samples) < 2:
            return Measurement(instrument=self.INSTRUMENT, target="",
                                value=0.0, unit="Hz", accuracy=self.ACCURACY)
        # Count rising-edge zero crossings
        crossings = 0
        last_below = self.samples[0][1] < self.v_threshold
        last_t = self.samples[0][0]
        period_sum = 0.0
        period_n = 0
        prev_cross_t: Optional[float] = None
        for t, v in self.samples:
            cur_below = v < self.v_threshold
            if last_below and not cur_below:
                # Rising edge
                if prev_cross_t is not None:
                    period_sum += (t - prev_cross_t)
                    period_n += 1
                prev_cross_t = t
                crossings += 1
            last_below = cur_below
        if period_n > 0:
            period = period_sum / period_n
            freq = 1.0 / period if period > 0 else 0.0
        else:
            # Fall back: 2 * crossings / gate_time
            t_end = self.samples[-1][0]
            t_start = self.samples[0][0]
            span = max(t_end - t_start, 1e-12)
            freq = crossings / span
        return Measurement(
            instrument=self.INSTRUMENT, target="",
            value=freq, unit="Hz", accuracy=self.ACCURACY,
            extras={"n_crossings": crossings, "n_periods": period_n,
                    "gate_time": self.gate_time,
                    "v_threshold": self.v_threshold},
        )

    def reset(self) -> None:
        self.samples.clear()