"""
Stable hashing utilities.

CircuitForge uses stable, deterministic hashes everywhere a fingerprint
of a circuit, a chip, a candidate, or a job configuration is required.
This ensures reproducibility and lets us cache simulation results.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping


def stable_hash(obj: Any) -> str:
    """
    Compute a stable SHA-256 hex digest of an arbitrary JSON-serializable
    object. Dict key order is canonicalized. Non-serializable objects raise.
    """
    canonical = json.dumps(
        obj, sort_keys=True, separators=(",", ":"), default=_json_default
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def content_hash(blob: bytes) -> str:
    """SHA-256 hex digest of raw bytes."""
    return hashlib.sha256(blob).hexdigest()


def _json_default(obj: Any):
    # Try to be helpful: numpy scalars, etc.
    if hasattr(obj, "item"):
        try:
            return obj.item()
        except Exception:
            pass
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
