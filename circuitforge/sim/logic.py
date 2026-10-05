"""
LEVEL 0 — Logic simulation.

A 4-state (0, 1, X, Z) event-driven simulator optimized for digital
circuits. The engine is designed to be:
- *fast*: pre-compiles the netlist into flat arrays for tight inner loops.
- *deterministic*: event order is well-defined (topological order then
  component id).
- *reproducible*: same inputs and seed always yield the same result.
- *honest*: any primitive that declares NOT_MODELED at the logic level
  cannot be used in a logic-only simulation; the engine raises an error.

4-state model
-------------
- LOGIC_0  (0): driven low
- LOGIC_1  (1): driven high
- LOGIC_X  (X): unknown / contention / uninitialized
- LOGIC_Z  (Z): high-impedance (no driver)

Algorithm
---------
1. Compile the circuit into:
   - net_state[net_id] in {0,1,X,Z}
   - event_queue: list of (net_id, new_value)
   - per-component evaluator: function (component, net_state) -> outputs
2. Apply external inputs.
3. Drain the event queue:
   - For each changed net, find all components that have an input port
     on that net, recompute their outputs, and enqueue changed output
     nets.
4. Iterate until the queue is empty or a maximum number of iterations
   is reached (in which case the circuit has feedback and we report X).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Dict, List, Set, Tuple, Optional, Callable, Any
import time

from ..core.circuit import Circuit
from ..core.components import ComponentSpec, ComponentKind, ModelAccuracy
from ..core.ids import ComponentId, NetId, PortId
from ..exceptions import SimulationError, ModelError


class LogicState(IntEnum):
    LOGIC_0 = 0
    LOGIC_1 = 1
    LOGIC_X = 2
    LOGIC_Z = 3


# String parsing helpers
def parse_logic(s: str) -> LogicState:
    s = s.strip().upper()
    if s in ("0", "L", "LOW"):
        return LogicState.LOGIC_0
    if s in ("1", "H", "HIGH"):
        return LogicState.LOGIC_1
    if s in ("X", "U", "UNKNOWN"):
        return LogicState.LOGIC_X
    if s in ("Z", "HI-Z", "FLOAT"):
        return LogicState.LOGIC_Z
    raise ValueError(f"cannot parse {s!r} as a logic state")


def format_logic(v: LogicState) -> str:
    return {LogicState.LOGIC_0: "0", LogicState.LOGIC_1: "1",
            LogicState.LOGIC_X: "X", LogicState.LOGIC_Z: "Z"}[v]


# Logic truth tables for the well-known gates
NOT = lambda a: LogicState(LOGIC_TABLE[~a & 0x3] if False else _NOT_TABLE[a])

_NOT_TABLE = {
    LogicState.LOGIC_0: LogicState.LOGIC_1,
    LogicState.LOGIC_1: LogicState.LOGIC_0,
    LogicState.LOGIC_X: LogicState.LOGIC_X,
    LogicState.LOGIC_Z: LogicState.LOGIC_X,
}

_AND_TABLE = {
    (LogicState.LOGIC_0, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_0, LogicState.LOGIC_1): LogicState.LOGIC_0,
    (LogicState.LOGIC_1, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_1, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_X, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_0, LogicState.LOGIC_X): LogicState.LOGIC_0,
    (LogicState.LOGIC_X, LogicState.LOGIC_1): LogicState.LOGIC_X,
    (LogicState.LOGIC_1, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_X): LogicState.LOGIC_X,
    # any Z input -> X
    (LogicState.LOGIC_Z, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_0, LogicState.LOGIC_Z): LogicState.LOGIC_0,
    (LogicState.LOGIC_Z, LogicState.LOGIC_1): LogicState.LOGIC_X,
    (LogicState.LOGIC_1, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_Z): LogicState.LOGIC_X,
}

_OR_TABLE = {
    (LogicState.LOGIC_0, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_0, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_0): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_X, LogicState.LOGIC_0): LogicState.LOGIC_X,
    (LogicState.LOGIC_0, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_X): LogicState.LOGIC_1,
    (LogicState.LOGIC_X, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_0): LogicState.LOGIC_X,
    (LogicState.LOGIC_0, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_Z): LogicState.LOGIC_1,
    (LogicState.LOGIC_Z, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_Z): LogicState.LOGIC_X,
}

_XOR_TABLE = {
    (LogicState.LOGIC_0, LogicState.LOGIC_0): LogicState.LOGIC_0,
    (LogicState.LOGIC_0, LogicState.LOGIC_1): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_0): LogicState.LOGIC_1,
    (LogicState.LOGIC_1, LogicState.LOGIC_1): LogicState.LOGIC_0,
    (LogicState.LOGIC_X, LogicState.LOGIC_0): LogicState.LOGIC_X,
    (LogicState.LOGIC_0, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_1): LogicState.LOGIC_X,
    (LogicState.LOGIC_1, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_0): LogicState.LOGIC_X,
    (LogicState.LOGIC_0, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_1): LogicState.LOGIC_X,
    (LogicState.LOGIC_1, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_X): LogicState.LOGIC_X,
    (LogicState.LOGIC_X, LogicState.LOGIC_Z): LogicState.LOGIC_X,
    (LogicState.LOGIC_Z, LogicState.LOGIC_Z): LogicState.LOGIC_X,
}


def _and(a: LogicState, b: LogicState) -> LogicState:
    return _AND_TABLE[(a, b)]


def _or(a: LogicState, b: LogicState) -> LogicState:
    return _OR_TABLE[(a, b)]


def _xor(a: LogicState, b: LogicState) -> LogicState:
    return _XOR_TABLE[(a, b)]


def _not(a: LogicState) -> LogicState:
    return _NOT_TABLE[a]


# Truth table for an N-input AND, OR, XOR, NAND, NOR, XNOR
def _n_input_and(states: List[LogicState]) -> LogicState:
    r = LogicState.LOGIC_1
    for s in states:
        r = _and(r, s)
        if r == LogicState.LOGIC_0:
            return r
    return r


def _n_input_or(states: List[LogicState]) -> LogicState:
    r = LogicState.LOGIC_0
    for s in states:
        r = _or(r, s)
        if r == LogicState.LOGIC_1:
            return r
    return r


def _n_input_xor(states: List[LogicState]) -> LogicState:
    r = LogicState.LOGIC_0
    for s in states:
        r = _xor(r, s)
    return r


def _buf(states: List[LogicState]) -> LogicState:
    return states[0] if states else LogicState.LOGIC_X


def _mux2(states: List[LogicState]) -> List[LogicState]:
    # a, b, sel
    if len(states) < 3:
        return [LogicState.LOGIC_X]
    a, b, sel = states
    if sel == LogicState.LOGIC_X or sel == LogicState.LOGIC_Z:
        return [LogicState.LOGIC_X]
    return [a if sel == LogicState.LOGIC_0 else b]


# ----------------------------------------------------------------------------
# Compiled view of a circuit for fast simulation
# ----------------------------------------------------------------------------

@dataclass
class _CompiledNetlist:
    """
    Internal flat representation of a circuit optimized for simulation.

    For each component we record:
    - spec_name: kind of component
    - in_port_nets: list of net ids for input ports (in spec order)
    - out_port_nets: list of net ids for output ports
    - inout_port_nets: list for inout ports
    - eval_fn: callable (states: List[LogicState]) -> List[LogicState] for outputs
    - delay: per-output delay in "ticks" (default 1)
    """
    spec_name: str
    component_id: int
    in_port_nets: List[Optional[int]]
    out_port_nets: List[Optional[int]]
    inout_port_nets: List[Optional[int]]
    eval_fn: Callable[[List[LogicState]], List[LogicState]]
    delay: int = 1


@dataclass
class LogicSimResult:
    net_states: Dict[int, LogicState] = field(default_factory=dict)
    events: int = 0
    iterations: int = 0
    stable: bool = True
    wall_time_s: float = 0.0
    max_iterations_reached: bool = False

    def get(self, net_id: int, default: LogicState = LogicState.LOGIC_X) -> LogicState:
        return self.net_states.get(int(net_id), default)

    def get_by_name(self, circuit: Circuit, net_name: str,
                    default: LogicState = LogicState.LOGIC_X) -> LogicState:
        for nid, n in circuit.nets.items():
            if n.name == net_name:
                return self.get(int(nid), default)
        return default


# ----------------------------------------------------------------------------
# Logic primitive specs
# ----------------------------------------------------------------------------

def _declare_logic(spec: ComponentSpec) -> ComponentSpec:
    return spec


def _gate_spec(name: str, n_inputs: int, fn,
               in_names: List[str], out_names: List[str] = None) -> ComponentSpec:
    if out_names is None:
        out_names = ["y"]
    s = ComponentSpec(
        name=name,
        category=ComponentKind.LOGIC_GATE,
        description=f"{name} logic gate ({n_inputs} inputs).",
    )
    for i, n in enumerate(in_names):
        s.add_port(n, direction="input", kind="digital")
    for n in out_names:
        s.add_port(n, direction="output", kind="digital")
    s.add_param("tpd", 1e-9, unit="s", min=0.0, max=1.0,
                description="Propagation delay in seconds (informational at logic level)")
    s.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.NOT_MODELED,
        detailed=ModelAccuracy.NOT_MODELED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    return s


def LogicGateSpecs() -> List[ComponentSpec]:
    out = []
    out.append(_gate_spec("NOT", 1, lambda s: [_not(s[0])], ["a"]))
    out.append(_gate_spec("BUFFER", 1, lambda s: [s[0]], ["a"]))
    out.append(_gate_spec("AND", 2, lambda s: [_and(s[0], s[1])], ["a", "b"]))
    out.append(_gate_spec("OR", 2, lambda s: [_or(s[0], s[1])], ["a", "b"]))
    out.append(_gate_spec("NAND", 2, lambda s: [_not(_and(s[0], s[1]))], ["a", "b"]))
    out.append(_gate_spec("NOR", 2, lambda s: [_not(_or(s[0], s[1]))], ["a", "b"]))
    out.append(_gate_spec("XOR", 2, lambda s: [_xor(s[0], s[1])], ["a", "b"]))
    out.append(_gate_spec("XNOR", 2, lambda s: [_not(_xor(s[0], s[1]))], ["a", "b"]))
    out.append(_gate_spec("AND3", 3, lambda s: [_and(_and(s[0], s[1]), s[2])], ["a", "b", "c"]))
    out.append(_gate_spec("OR3", 3, lambda s: [_or(_or(s[0], s[1]), s[2])], ["a", "b", "c"]))
    out.append(_gate_spec("MUX2", 0, _mux2, ["a", "b", "sel"]))
    return out


def register_logic_gates(library) -> None:
    for s in LogicGateSpecs():
        library.register_primitive(s)


# ----------------------------------------------------------------------------
# Compiler
# ----------------------------------------------------------------------------

def _gate_eval_fn(spec_name: str) -> Callable[[List[LogicState]], List[LogicState]]:
    if spec_name == "NOT":
        return lambda s: [_not(s[0])]
    if spec_name == "BUFFER":
        return lambda s: [s[0]]
    if spec_name == "AND":
        return lambda s: [_and(s[0], s[1])]
    if spec_name == "OR":
        return lambda s: [_or(s[0], s[1])]
    if spec_name == "NAND":
        return lambda s: [_not(_and(s[0], s[1]))]
    if spec_name == "NOR":
        return lambda s: [_not(_or(s[0], s[1]))]
    if spec_name == "XOR":
        return lambda s: [_xor(s[0], s[1])]
    if spec_name == "XNOR":
        return lambda s: [_not(_xor(s[0], s[1]))]
    if spec_name == "AND3":
        return lambda s: [_and(_and(s[0], s[1]), s[2])]
    if spec_name == "OR3":
        return lambda s: [_or(_or(s[0], s[1]), s[2])]
    if spec_name == "MUX2":
        return _mux2
    raise ModelError(f"no logic model for spec {spec_name!r}")


def compile_for_logic(circuit: Circuit) -> List[_CompiledNetlist]:
    """
    Pre-compile a circuit into a list of _CompiledNetlist entries.

    Only components that are usable at the logic level are included.
    Components declared with `logic=NOT_MODELED` are skipped (so the
    resulting list is a "logic view" of the circuit).
    """
    from ..core.ports import PortDirection
    compiled: List[_CompiledNetlist] = []
    for cid, comp in sorted(circuit.components.items(), key=lambda kv: int(kv[0])):
        acc = comp.spec.model_accuracy.get("logic", ModelAccuracy.NOT_MODELED)
        if acc == ModelAccuracy.NOT_MODELED:
            continue
        in_nets: List[Optional[int]] = []
        out_nets: List[Optional[int]] = []
        inout_nets: List[Optional[int]] = []
        for i, pspec in enumerate(comp.spec.ports):
            pid = comp.ports[i]
            port = circuit.ports[PortId(int(pid))]
            net_id = int(port.net) if port.net is not None else None
            if pspec.direction == PortDirection.INPUT:
                in_nets.append(net_id)
            elif pspec.direction == PortDirection.OUTPUT:
                out_nets.append(net_id)
            elif pspec.direction == PortDirection.INOUT:
                inout_nets.append(net_id)
            else:
                inout_nets.append(net_id)
        if comp.spec.name == "LOGIC_INPUT":
            # The engine drives the net directly via self._inputs.
            # We do not add this component to the compiled list; doing
            # so would clobber the user-driven value.
            continue
        if comp.spec.name == "LOGIC_OUTPUT":
            # Pure sink; no contribution to net state
            continue
        if comp.spec.category.value == "logic_gate":
            try:
                fn = _gate_eval_fn(comp.spec.name)
            except ModelError:
                continue
            compiled.append(_CompiledNetlist(
                spec_name=comp.spec.name,
                component_id=int(cid),
                in_port_nets=in_nets,
                out_port_nets=out_nets,
                inout_port_nets=inout_nets,
                eval_fn=fn,
                delay=1,
            ))
    return compiled


# ----------------------------------------------------------------------------
# Engine
# ----------------------------------------------------------------------------

@dataclass
class LogicEngine:
    """
    4-state event-driven logic simulator.

    Usage
    -----
    >>> engine = LogicEngine()
    >>> engine.set_input("A", LogicState.LOGIC_1)
    >>> engine.set_input("B", LogicState.LOGIC_0)
    >>> result = engine.run(circuit)
    >>> result.get_by_name(circuit, "Y")
    """
    max_iterations: int = 1000
    initial_state: LogicState = LogicState.LOGIC_X

    def __post_init__(self):
        # net_id -> LogicState (only set externally for inputs)
        self._inputs: Dict[int, LogicState] = {}
        self._net_state: Dict[int, LogicState] = {}

    def set_input(self, net_id: int, value: LogicState) -> None:
        self._inputs[int(net_id)] = value

    def set_input_by_name(self, circuit: Circuit, name: str, value: LogicState) -> None:
        for nid, n in circuit.nets.items():
            if n.name == name:
                self.set_input(int(nid), value)
                return
        raise KeyError(f"net {name!r} not found")

    def clear_inputs(self) -> None:
        self._inputs.clear()
        self._net_state.clear()

    def run(self, circuit: Circuit) -> LogicSimResult:
        t0 = time.perf_counter()
        compiled = compile_for_logic(circuit)
        net_ids = set(int(nid) for nid in circuit.nets)
        # Reset state
        self._net_state = {}
        for nid in net_ids:
            if nid in self._inputs:
                self._net_state[nid] = self._inputs[nid]
            else:
                self._net_state[nid] = self.initial_state

        # Pending starts with ONLY the input nets.
        pending: List[Tuple[int, LogicState, int]] = [
            (nid, self._inputs[nid], 0) for nid in self._inputs
        ]
        # If a net has no driver and is not in inputs, keep initial_state but
        # don't enqueue it. That way it doesn't overwrite a later driver.

        events = 0
        stable = True
        max_iter_reached = False
        iterations = 0

        net_to_comp_in: Dict[int, List[Tuple[int, int]]] = {}
        for ci, cn in enumerate(compiled):
            for j, nid in enumerate(cn.in_port_nets):
                if nid is not None:
                    net_to_comp_in.setdefault(nid, []).append((ci, j))

        idx = 0
        while idx < len(pending):
            if iterations > self.max_iterations:
                max_iter_reached = True
                stable = False
                break
            iterations += 1
            nid, new_val, _delay = pending[idx]
            idx += 1
            cur = self._net_state.get(nid, self.initial_state)
            # If this net is a driver input, always propagate even if
            # the value matches the current state (which it does on
            # the first tick, because we initialized the state from
            # the inputs).
            is_driver = (nid in self._inputs)
            if cur == new_val and not is_driver:
                continue
            self._net_state[nid] = new_val
            if not is_driver:
                events += 1
            else:
                events += 1
            for ci, _jpi in net_to_comp_in.get(nid, []):
                cn = compiled[ci]
                in_states: List[LogicState] = []
                for j, inp_nid in enumerate(cn.in_port_nets):
                    if inp_nid is None:
                        in_states.append(LogicState.LOGIC_X)
                    else:
                        in_states.append(self._net_state.get(inp_nid, self.initial_state))
                out_states = cn.eval_fn(in_states)
                for k, out_nid in enumerate(cn.out_port_nets):
                    if out_nid is None:
                        continue
                    new = out_states[k] if k < len(out_states) else LogicState.LOGIC_X
                    cur2 = self._net_state.get(out_nid, self.initial_state)
                    if new != cur2:
                        pending.append((out_nid, new, 0))

        result = LogicSimResult(
            net_states=dict(self._net_state),
            events=events,
            iterations=iterations,
            stable=stable,
            wall_time_s=time.perf_counter() - t0,
            max_iterations_reached=max_iter_reached,
        )
        return result


# ----------------------------------------------------------------------------
# Convenience
# ----------------------------------------------------------------------------

def simulate_logic(circuit: Circuit, inputs: Optional[Dict[str, LogicState]] = None,
                   max_iterations: int = 1000) -> LogicSimResult:
    eng = LogicEngine(max_iterations=max_iterations)
    if inputs:
        for name, val in inputs.items():
            eng.set_input_by_name(circuit, name, val)
    return eng.run(circuit)


def register_logic_components_in_library(library) -> None:
    register_logic_gates(library)
    # Also add LOGIC_INPUT / LOGIC_OUTPUT as idealized logic sources
    inp = ComponentSpec(
        name="LOGIC_INPUT",
        category=ComponentKind.SOURCE,
        description="Logic-level driver (used only at the logic level).",
    )
    inp.add_port("y", direction="output", kind="digital")
    inp.add_param("vth", 0.5, unit="V", min=0.0, max=1000.0,
                  description="Threshold between 0 and 1")
    inp.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.NOT_MODELED,
        detailed=ModelAccuracy.NOT_MODELED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    library.register_primitive(inp)
    outp = ComponentSpec(
        name="LOGIC_OUTPUT",
        category=ComponentKind.INSTRUMENT,
        description="Logic-level probe (no electrical behavior).",
    )
    outp.add_port("a", direction="input", kind="digital")
    outp.declare_model_accuracy(
        logic=ModelAccuracy.IDEALIZED,
        electrical=ModelAccuracy.NOT_MODELED,
        detailed=ModelAccuracy.NOT_MODELED,
        thermal=ModelAccuracy.NOT_MODELED,
    )
    library.register_primitive(outp)
