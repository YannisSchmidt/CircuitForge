"""
GPU detection and CPU/GPU dispatch layer (section 14 of the spec).

CircuitForge prefers NumPy on CPU. Optional GPU acceleration is
offered via CuPy when available, but the system is fully
functional without GPU.

Use ``get_engine()`` to obtain an object that exposes a numpy-like
API. All heavy numerical routines in the simulator use this engine
so that GPU acceleration is a drop-in upgrade without changing
callers.

We do NOT use the GPU unless the workload is large enough that the
GPU's overhead is amortized. The threshold is configurable via
``GPU_THRESHOLD``.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Optional


# Heuristic: at or below this number of unknowns we use CPU. Above,
# we prefer GPU if available.
DEFAULT_GPU_THRESHOLD = 256

# Global flag to disable GPU entirely. Useful for benchmarking
# comparisons.
_force_cpu: bool = False


def set_force_cpu(value: bool) -> None:
    """Force the engine to use CPU. Useful for benchmarking and
    reproducibility."""
    global _force_cpu
    _force_cpu = value


def is_gpu_available() -> bool:
    """Return True if a GPU backend is available *and* the user
    hasn't forced CPU."""
    if _force_cpu:
        return False
    if os.environ.get("CIRCUITFORGE_NO_GPU"):
        return False
    try:
        import cupy  # type: ignore
        return cupy.cuda.is_available()
    except Exception:
        return False


@dataclass
class EngineInfo:
    """Diagnostic info about a chosen engine."""
    name: str
    is_gpu: bool
    version: str
    n_devices: int
    device_names: list


def get_engine_info() -> EngineInfo:
    if is_gpu_available():
        try:
            import cupy
            n = cupy.cuda.runtime.getDeviceCount()
            names = [cupy.cuda.runtime.getDeviceProperties(i).get("name", "?")
                     for i in range(n)]
            return EngineInfo(
                name="cupy", is_gpu=True, version=cupy.__version__,
                n_devices=n, device_names=names,
            )
        except Exception:
            pass
    import numpy as np
    return EngineInfo(
        name="numpy", is_gpu=False, version=np.__version__,
        n_devices=0, device_names=[],
    )


class Engine:
    """
    A thin wrapper that exposes a numpy-like API and dispatches to
    GPU if available and beneficial, else CPU.
    """

    def __init__(self, prefer_gpu: bool = True, threshold: int = DEFAULT_GPU_THRESHOLD):
        self._prefer_gpu = prefer_gpu
        self._threshold = threshold
        self._n_calls = 0
        self._n_gpu_calls = 0
        self._n_cpu_calls = 0
        self._total_gpu_time = 0.0
        self._total_cpu_time = 0.0
        self._backend_name = "numpy"
        self._cupy = None
        self._numpy = None
        self._init()

    def _init(self):
        import numpy as np
        self._numpy = np
        if self._prefer_gpu and is_gpu_available():
            try:
                import cupy as cp
                self._cupy = cp
                self._backend_name = "cupy"
            except Exception:
                pass

    @property
    def backend(self) -> str:
        return self._backend_name

    @property
    def np(self):
        """The numpy module (always available)."""
        return self._numpy

    @property
    def is_gpu(self) -> bool:
        return self._cupy is not None

    def _maybe_use_gpu(self, n: int):
        """Decide whether to use GPU for an op of size n."""
        if self._cupy is None:
            return False
        return n >= self._threshold

    def array(self, data, dtype=None):
        """Create an array on the most appropriate device."""
        if self._cupy is not None and self._maybe_use_gpu(len(data) if hasattr(data, "__len__") else 0):
            return self._cupy.asarray(data, dtype=dtype)
        return self._numpy.asarray(data, dtype=dtype)

    def to_host(self, arr):
        """Move an array back to host (CPU)."""
        if self._cupy is not None and hasattr(arr, "device"):
            if arr.device.id is not None:
                return self._cupy.asnumpy(arr)
        return arr

    def solve(self, A, b):
        """Solve A x = b. Returns x on the host."""
        n = A.shape[0]
        self._n_calls += 1
        t0 = time.perf_counter()
        if self._cupy is not None and self._maybe_use_gpu(n * n):
            A_dev = self._cupy.asarray(A)
            b_dev = self._cupy.asarray(b)
            x = self._cupy.linalg.solve(A_dev, b_dev)
            x = self._cupy.asnumpy(x)
            self._n_gpu_calls += 1
            self._total_gpu_time += time.perf_counter() - t0
        else:
            x = self._numpy.linalg.solve(A, b)
            self._n_cpu_calls += 1
            self._total_cpu_time += time.perf_counter() - t0
        return x

    def matmul(self, A, B):
        n = A.shape[0]
        self._n_calls += 1
        t0 = time.perf_counter()
        if self._cupy is not None and self._maybe_use_gpu(n * n):
            A_dev = self._cupy.asarray(A)
            B_dev = self._cupy.asarray(B)
            C = self._cupy.matmul(A_dev, B_dev)
            C = self._cupy.asnumpy(C)
            self._n_gpu_calls += 1
            self._total_gpu_time += time.perf_counter() - t0
        else:
            C = self._numpy.matmul(A, B)
            self._n_cpu_calls += 1
            self._total_cpu_time += time.perf_counter() - t0
        return C

    def stats(self):
        return {
            "backend": self._backend_name,
            "n_calls": self._n_calls,
            "n_cpu": self._n_cpu_calls,
            "n_gpu": self._n_gpu_calls,
            "cpu_time_s": self._total_cpu_time,
            "gpu_time_s": self._total_gpu_time,
        }


# Default singleton
_default_engine: Optional[Engine] = None


def get_engine() -> Engine:
    """Return the default engine (lazy-init)."""
    global _default_engine
    if _default_engine is None:
        _default_engine = Engine()
    return _default_engine


def reset_engine() -> None:
    """Reset the default engine (re-initializes from current settings)."""
    global _default_engine
    _default_engine = Engine()


def benchmark(stop: int = 1024, factor: int = 2, n_iters: int = 3) -> dict:
    """
    Run a small benchmark that times CPU vs GPU solve for matrices
    of increasing size. Returns a dict with results.
    """
    import numpy as np
    results = {
        "cpu": [],
        "gpu": [],
        "n": [],
        "is_gpu_available": is_gpu_available(),
    }
    n = 16
    engine = get_engine()
    for _ in range(int(stop).bit_length() // factor):
        results["n"].append(n)
        A = np.random.randn(n, n)
        b = np.random.randn(n)
        # CPU
        if engine._cupy is not None:
            t0 = time.perf_counter()
            for _ in range(n_iters):
                x = engine._numpy.linalg.solve(A, b)
            cpu_t = (time.perf_counter() - t0) / n_iters
        else:
            t0 = time.perf_counter()
            for _ in range(n_iters):
                x = np.linalg.solve(A, b)
            cpu_t = (time.perf_counter() - t0) / n_iters
        results["cpu"].append(cpu_t)
        # GPU
        if engine._cupy is not None:
            t0 = time.perf_counter()
            for _ in range(n_iters):
                x = engine.solve(A, b)
            gpu_t = (time.perf_counter() - t0) / n_iters
            results["gpu"].append(gpu_t)
        n *= factor
    return results