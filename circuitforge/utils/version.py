"""
Versioning helpers.

Two distinct version numbers:
- engine_version: implementation version. Bumped on any change to the
  simulation, optimization, or analysis code that could yield a different
  result on the same input.
- schema_version: serialization format version. Bumped only when the
  on-disk format changes incompatibly.
"""

from __future__ import annotations

from circuitforge import __version__, __engine_version__, __schema_version__


def engine_version() -> str:
    return __engine_version__


def schema_version() -> int:
    return __schema_version__


def format_version_info() -> str:
    return (
        f"CircuitForge package={__version__} "
        f"engine={__engine_version__} schema={__schema_version__}"
    )
