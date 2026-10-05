"""
Stable, typed identifiers.

We use plain Python ints as identifiers for performance. They are wrapped
in a tagged class so the type system prevents mixing up, e.g., a
ComponentId with a NetId.
"""

from __future__ import annotations
from typing import NewType, Union

# A newtype would be ideal but the dataclass-based approach is more
# flexible. We use lightweight wrapper classes that behave like int.

class _Id:
    __slots__ = ("_v",)

    def __init__(self, v: int):
        if not isinstance(v, int):
            raise TypeError(f"id must be int, got {type(v).__name__}")
        self._v = int(v)

    def __int__(self) -> int:
        return self._v

    def __index__(self) -> int:
        return self._v

    def __hash__(self) -> int:
        return hash((type(self).__name__, self._v))

    def __eq__(self, other) -> bool:
        if isinstance(other, _Id):
            return type(self) is type(other) and self._v == other._v
        if isinstance(other, int):
            return self._v == other
        return NotImplemented

    def __lt__(self, other):
        if isinstance(other, _Id):
            return (type(self).__name__, self._v) < (type(other).__name__, other._v)
        if isinstance(other, int):
            return self._v < other
        return NotImplemented

    def __le__(self, other):
        if isinstance(other, _Id):
            return (type(self).__name__, self._v) <= (type(other).__name__, other._v)
        if isinstance(other, int):
            return self._v <= other
        return NotImplemented

    def __gt__(self, other):
        return not self.__le__(other)

    def __ge__(self, other):
        return not self.__lt__(other)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._v})"

    def __str__(self) -> str:
        return f"{type(self).__name__}#{self._v}"

    def __format__(self, spec: str) -> str:
        if spec:
            return format(str(self), spec)
        return str(self)


class NodeId(_Id):
    """Identifier of a node in the graph (internal continuity)."""


class ComponentId(_Id):
    """Identifier of a component instance within a circuit."""


class NetId(_Id):
    """Identifier of an electrical net (a set of connected ports)."""


class PortId(_Id):
    """Identifier of a port (a component endpoint)."""


class ChipId(_Id):
    """Identifier of a hierarchical chip (sub-circuit)."""
