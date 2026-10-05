"""
Lightweight unit and quantity module.

We deliberately avoid implicit conversions between unit systems. Every
quantity is stored as a bare float in its SI base unit. The `Quantity`
class only attaches a *display name* and a *symbol* so we can produce
correct-looking reports without hiding anything from the user.

This is a conscious engineering decision: the spec (section 35) is
explicit that approximations and conversions must be documented and
inspectable. A heavy unit library with implicit conversion would make it
too easy to silently mix unit systems. The helpers here are limited to
formatting and stringification.

SI base units used everywhere internally
----------------------------------------
- Voltage:         V
- Current:         A
- Resistance:      ohm
- Capacitance:     F
- Inductance:      H
- Power:           W
- Energy:          J
- Temperature:     K   (Celsius is only used for display, with explicit offset)
- Frequency:       Hz
- Time:            s
"""

from __future__ import annotations

from dataclasses import dataclass

from ..exceptions import CircuitForgeError


@dataclass(frozen=True)
class Unit:
    name: str
    symbol: str


V = Unit("volt", "V")
A = Unit("ampere", "A")
OHM = Unit("ohm", "Ω")
F = Unit("farad", "F")
H = Unit("henry", "H")
W = Unit("watt", "W")
J = Unit("joule", "J")
K = Unit("kelvin", "K")
HZ = Unit("hertz", "Hz")
S = Unit("second", "s")


class Quantity:
    """
    A physical quantity: a float in SI base units plus a unit object.

    Arithmetic between quantities requires matching units, otherwise an
    error is raised. This prevents accidental mixing of incompatible
    physical dimensions. Multiplying a Voltage by a Current yields a
    Power automatically (this is a physically legitimate operation).
    """

    __slots__ = ("value", "unit")

    def __init__(self, value: float, unit: Unit):
        self.value = float(value)
        self.unit = unit

    # ---- python protocol ----
    def __repr__(self) -> str:
        return f"Quantity({self.value!r}, {self.unit.symbol})"

    def __str__(self) -> str:
        return f"{self.value} {self.unit.symbol}"

    def __format__(self, spec: str) -> str:
        if not spec:
            return f"{_fmt_num(self.value)} {self.unit.symbol}"
        # e.g. ":.3f" returns only the number
        if spec.startswith(":"):
            return format(self.value, spec[1:])
        return f"{format(self.value, spec)} {self.unit.symbol}"

    # ---- equality / hash ----
    def __eq__(self, other) -> bool:
        if isinstance(other, Quantity):
            return self.unit.name == other.unit.name and self.value == other.value
        return NotImplemented

    def __hash__(self):
        return hash((self.value, self.unit.name))

    # ---- arithmetic (only between compatible units) ----
    def __add__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="add")
        return Quantity(self.value + other.value, self.unit)

    def __sub__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="sub")
        return Quantity(self.value - other.value, self.unit)

    def __mul__(self, other):
        other = self._coerce(other)
        prod_unit = _product_unit(self.unit, other.unit)
        return Quantity(self.value * other.value, prod_unit)

    def __truediv__(self, other):
        other = self._coerce(other)
        if other.unit.name == self.unit.name:
            return Quantity(self.value / other.value, _dimensionless)
        return Quantity(self.value / other.value, _product_unit(self.unit, _inverse_unit(other.unit)))

    def __neg__(self):
        return Quantity(-self.value, self.unit)

    def __pos__(self):
        return Quantity(+self.value, self.unit)

    def __abs__(self):
        return Quantity(abs(self.value), self.unit)

    def __lt__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="compare")
        return self.value < other.value

    def __le__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="compare")
        return self.value <= other.value

    def __gt__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="compare")
        return self.value > other.value

    def __ge__(self, other):
        other = self._coerce(other)
        if other.unit.name != self.unit.name:
            raise UnitMismatch(self.unit, other.unit, op="compare")
        return self.value >= other.value

    def _coerce(self, other):
        if isinstance(other, Quantity):
            return other
        if isinstance(other, (int, float)):
            # plain number treated as "value in same unit"
            return Quantity(float(other), self.unit)
        return NotImplemented

    def to(self, unit: Unit) -> "Quantity":
        if unit.name == self.unit.name:
            return self
        raise UnitMismatch(self.unit, unit, op="convert")


class UnitMismatch(CircuitForgeError):
    def __init__(self, a: Unit, b: Unit, op: str):
        super().__init__(f"unit mismatch in {op}: {a.symbol} vs {b.symbol}")
        self.a = a
        self.b = b
        self.op = op


# ---- helpers for unit products ----
_dimensionless = Unit("dimensionless", "")


def _product_unit(a: Unit, b: Unit) -> Unit:
    if a.name == "dimensionless":
        return b
    if b.name == "dimensionless":
        return a
    return Unit(name=f"{a.name}*{b.name}", symbol=f"{a.symbol}·{b.symbol}")


def _inverse_unit(u: Unit) -> Unit:
    if u.name == "dimensionless":
        return u
    return Unit(name=f"1/{u.name}", symbol=f"1/{u.symbol}")


def Q_(value, unit: Unit) -> Quantity:
    return Quantity(value, unit)


# Aliases for readability
def Voltage(v): return Quantity(v, V)
def Current(c): return Quantity(c, A)
def Resistance(r): return Quantity(r, OHM)
def Capacitance(c): return Quantity(c, F)
def Inductance(l): return Quantity(l, H)
def Power(p): return Quantity(p, W)
def Energy(e): return Quantity(e, J)
def Temperature(t): return Quantity(t, K)
def Frequency(f): return Quantity(f, HZ)
def Time(t): return Quantity(t, S)


def _fmt_num(x: float) -> str:
    """Format a number, choosing a sensible scientific vs decimal form."""
    if x == 0:
        return "0"
    ax = abs(x)
    if ax >= 1e4 or ax < 1e-3:
        return f"{x:.4g}"
    return f"{x:.4g}"


# SI prefix helper for human-readable strings
_PREFIXES = [
    (1e-15, "f"),
    (1e-12, "p"),
    (1e-9,  "n"),
    (1e-6,  "µ"),
    (1e-3,  "m"),
    (1e0,   ""),
    (1e3,   "k"),
    (1e6,   "M"),
    (1e9,   "G"),
    (1e12,  "T"),
]


def human_si(value: float, unit: Unit) -> str:
    """Format a value with a sensible SI prefix, e.g. 10000 -> '10k'."""
    if value == 0:
        return f"0 {unit.symbol}"
    ax = abs(value)
    # find best prefix
    for scale, prefix in reversed(_PREFIXES):
        if ax >= scale:
            scaled = value / scale
            return f"{scaled:.4g} {prefix}{unit.symbol}"
    return f"{value:.4g} {unit.symbol}"


# Temperature helpers (only for DISPLAY; storage stays in K)
CELSIUS_OFFSET = 273.15


def c_to_k(c: float) -> float:
    return c + CELSIUS_OFFSET


def k_to_c(k: float) -> float:
    return k - CELSIUS_OFFSET
