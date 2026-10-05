"""
Deterministic, reproducible random number generation.

Reproducibility is a hard requirement of CircuitForge (see section 16 of the
specification). We therefore expose a single RNG that is always derived from
an explicit seed. Randomness used in the optimizer, the mutator, or even the
component reference generator is always drawn from a DeterministicRNG instance
so that two identical runs always produce the same sequence.

We do NOT rely on Python's global random module. Every random operation
takes a DeterministicRNG argument. This is enforced by code review and tests.
"""

from __future__ import annotations

import hashlib
import random
from typing import Optional, Sequence

import numpy as np


# Global per-thread default RNG. Lazily initialized. Tests reset it.
_DEFAULT_RNG: Optional["DeterministicRNG"] = None


class DeterministicRNG:
    """
    A deterministic pseudo-random number generator.

    Backed by both Python's `random.Random` (for arbitrary Python
    distributions) and NumPy's PCG64 (for vectorized operations). Both
    are seeded from the same base seed so they stay in lock-step.

    Parameters
    ----------
    seed: int, str, or bytes
        Any hashable seed value. Strings are hashed to a 64-bit int.
    """

    def __init__(self, seed):
        if isinstance(seed, str):
            seed = seed_from_string(seed)
        elif isinstance(seed, (bytes, bytearray)):
            seed = int.from_bytes(hashlib.sha256(seed).digest()[:8], "big")
        elif not isinstance(seed, int):
            raise TypeError(f"seed must be int, str, or bytes, got {type(seed)}")
        self._seed = int(seed) & 0xFFFFFFFFFFFFFFFF
        self._py = random.Random(self._seed)
        self._np = np.random.default_rng(self._seed)
        # Counter to derive independent streams when sub-seeds are needed.
        self._counter = 0

    # ---- accessors ----
    @property
    def seed(self) -> int:
        return self._seed

    def fork(self, label: str | int = "") -> "DeterministicRNG":
        """Return a child RNG derived deterministically from this one."""
        self._counter += 1
        data = f"{self._seed}:{self._counter}:{label}".encode("utf-8")
        child_seed = int.from_bytes(hashlib.sha256(data).digest()[:8], "big")
        return DeterministicRNG(child_seed)

    # ---- Python distributions ----
    def random(self) -> float:
        return self._py.random()

    def randint(self, a: int, b: int) -> int:
        return self._py.randint(a, b)

    def choice(self, seq: Sequence):
        if not seq:
            raise IndexError("cannot choose from empty sequence")
        return self._py.choice(seq)

    def choices(self, population, k: int, weights=None):
        return self._py.choices(population, k=k, weights=weights)

    def shuffle(self, lst: list) -> list:
        self._py.shuffle(lst)
        return lst

    def gauss(self, mu: float = 0.0, sigma: float = 1.0) -> float:
        return self._py.gauss(mu, sigma)

    def uniform(self, a: float, b: float) -> float:
        return self._py.uniform(a, b)

    def sample(self, population, k: int):
        return self._py.sample(population, k=k)

    # ---- NumPy distributions ----
    def np_uniform(self, low=0.0, high=1.0, size=None):
        return self._np.uniform(low, high, size=size)

    def np_integers(self, low, high=None, size=None):
        return self._np.integers(low, high, size=size)

    def np_normal(self, loc=0.0, scale=1.0, size=None):
        return self._np.normal(loc, scale, size=size)

    def np_choice(self, a, size=None, replace=True, p=None):
        return self._np.choice(a, size=size, replace=replace, p=p)

    def np_shuffle(self, arr):
        return self._np.shuffle(arr)


def seed_from_string(s: str) -> int:
    """Map any string to a 64-bit integer seed (SHA-256, first 8 bytes)."""
    if not isinstance(s, str):
        raise TypeError("expected str")
    return int.from_bytes(hashlib.sha256(s.encode("utf-8")).digest()[:8], "big")


def get_rng() -> DeterministicRNG:
    """Return the process-wide default RNG, initializing it if needed."""
    global _DEFAULT_RNG
    if _DEFAULT_RNG is None:
        _DEFAULT_RNG = DeterministicRNG(0xC1FCF01)
    return _DEFAULT_RNG


def reset_global_rng(seed) -> DeterministicRNG:
    """Reset the process-wide RNG to a specific seed. For tests / reproducibility."""
    global _DEFAULT_RNG
    _DEFAULT_RNG = DeterministicRNG(seed)
    return _DEFAULT_RNG
