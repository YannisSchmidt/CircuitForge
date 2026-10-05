# CircuitForge User Guide

This guide walks you through the most common tasks.

## 1. Build a circuit

The core API gives you full programmatic control over the graph.

```python
from circuitforge.core import build_circuit, add_component, connect
from circuitforge.sim.logic import register_logic_components_in_library

c = build_circuit("my_circuit")
register_logic_components_in_library(c.library)

# Add components
a = add_component(c, "LOGIC_INPUT", reference="A")
b = add_component(c, "LOGIC_INPUT", reference="B")
g = add_component(c, "AND", reference="G")
o = add_component(c, "LOGIC_OUTPUT", reference="O")

# Connect them
connect(c, a.ports[0], g.ports[0])
connect(c, b.ports[0], g.ports[1])
connect(c, g.ports[2], o.ports[0])
```

## 2. Run a logic simulation

```python
from circuitforge.sim.logic import simulate_logic, LogicState

result = simulate_logic(c, {"A": LogicState(1), "B": LogicState(0)})
print(result.net_states)  # {net_id: LogicState}
```

The simulator is event-driven and converges to a fixed point in at most
`max_iterations` ticks. It supports 4 logic states: `0`, `1`, `X`, `Z`.

## 3. Run an electrical simulation

```python
from circuitforge.sim.electrical import simulate_electrical, ElectricalSimOptions

opts = ElectricalSimOptions(t_start=0, t_stop=1e-6, dt=1e-9, max_newton=20)
result = simulate_electrical(c, opts)
```

The electrical simulator uses Modified Nodal Analysis (MNA) with
Newton-Raphson for non-linear devices. Capacitors and inductors use
Backward Euler for stability.

## 4. Run a thermal simulation

```python
from circuitforge.thermal import default_thermal_for_circuit, run_thermal

net = default_thermal_for_circuit(c)
powers = {cid: 0.1 for cid in net.nodes}  # 100 mW per component
series = [(0, powers), (1, powers), (2, powers)]  # 3 timesteps
result = run_thermal(net, series, t_stop=2, dt=0.1)
print(result.t_max)  # max temperature reached
```

## 5. Save and load a project

```python
from circuitforge.io.serialize import project_to_json, project_from_json

s = project_to_json(c)  # JSON string
c2 = project_from_json(s)  # round-trip
```

The schema is versioned; loading a project from a newer schema raises
`SchemaError`.

## 6. Auto-design

```python
from circuitforge.optim.specification import AutoDesignSpec
from circuitforge.optim.synthesizer import auto_design
from circuitforge.optim.search import SearchConfig

spec = AutoDesignSpec(
    category="ADDER",
    description="4-bit adder",
    parameters={"n_bits": 4},
    target_operations=[],
    optimization_profile="balanced",
)
cfg = SearchConfig(population_size=32, n_generations=20, time_budget_s=30)
cand = auto_design(spec, cfg)
print(f"Best candidate: {cand.fingerprint}")
print(f"  components: {cand.evaluation.n_components}")
print(f"  score:      {cand.evaluation.score}")
```

The search is reproducible: same seed + same config always produces the
same best candidate.

## 7. Validate a circuit

```python
from circuitforge.validation import (
    validate_logic, validate_electrical, validate_thermal, validate_timing,
)

# Validate against a golden function
def golden(v):
    a, b = v[0], v[1]
    return [a & b]

rep = validate_logic(c, golden, exhaustive=True)
print(rep.summary())  # passed/failed/skipped
```

## 8. Use virtual instruments

```python
from circuitforge.instruments import VMM1, TINY_OSC, FND2

vmm = VMM1()
for i in range(100):
    vmm.sample("VOUT", i * 0.001, 3.3)
m = vmm.read("VOUT")
print(m.summary())  # VMM-1(VOUT) = 3.3 V
```

## 9. Detect repeated subcircuits

```python
from circuitforge.patterns import find_repeated_patterns

patterns = find_repeated_patterns(c)
for p in patterns:
    print(p.summary())  # Pattern (AND|OR): 4 occurrences, 3 components each
```

## 10. Use the CLI

```bash
python -m circuitforge.cli info my_project.json
python -m circuitforge.cli simulate my_project.json --logic
python -m circuitforge.cli auto-design --category adder --bits 4
python -m circuitforge.cli benchmark --output bench.json
python -m circuitforge.cli gpu-info
```

## 11. Use the GUI

```bash
python -m circuitforge.gui
```

The GUI lets you open a JSON project, simulate it, validate it, and save
changes. A full schematic editor is on the roadmap.

## 12. Reproducibility and accuracy

All simulations, optimizations, and benchmarks are deterministic given
the same seed, parameters, and engine version. Every "best" result is
qualified with the search constraints, the candidate count, the
simulation level, and the ranking criteria. See `docs/SPEC.md` section
33 for details.