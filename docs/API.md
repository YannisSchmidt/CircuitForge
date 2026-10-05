# CircuitForge Public API Reference

This document is a curated reference of the public API. For every module,
the most-used functions and classes are listed.

> **Stability**: The public API is considered stable within a major version.
> Internal helpers (prefixed with `_`) may change without notice.

## `circuitforge.core`

```python
build_circuit(name: str) -> Circuit
add_component(circuit, spec, reference="", params=None, position=(0,0), rotation=0) -> Component
connect(circuit, port_a, port_b) -> None
```

`add_component` accepts either a `ComponentSpec` or a string name (which
is resolved via the circuit's library).

## `circuitforge.sim.logic`

```python
simulate_logic(circuit, inputs=None, max_iterations=1000) -> LogicSimResult
register_logic_components_in_library(library) -> None
```

`inputs` is a dict of net name -> `LogicState`.

## `circuitforge.sim.electrical`

```python
simulate_electrical(circuit, options) -> ElectricalSimResult
ElectricalSimOptions(t_start=0, t_stop=1e-6, dt=1e-9, max_newton=20)
```

## `circuitforge.thermal`

```python
default_thermal_for_circuit(circuit, ambient_temp=300.15) -> ThermalNetwork
run_thermal(network, power_series, t_stop, dt) -> ThermalSimResult
```

## `circuitforge.io.serialize`

```python
project_to_json(circuit) -> str
project_from_json(s) -> Circuit
```

## `circuitforge.optim`

```python
AutoDesignSpec(category, description, parameters, target_operations, optimization_profile)
SearchConfig(population_size, n_generations, mutation_rate, crossover_rate,
             elite_fraction, time_budget_s, seed)
auto_design(spec, config) -> Candidate
synthesize_for_spec(spec, config) -> SearchResult
```

Profiles: `FASTEST`, `SMALLEST`, `LOW_POWER`, `LOW_TEMP`, `MOST_STABLE`, `BALANCED`.

## `circuitforge.validation`

```python
validate_logic(circuit, golden, exhaustive=False, max_random=256, seed=None) -> ValidationReport
validate_electrical(circuit, t_stop=1e-6, dt=1e-9) -> ValidationReport
validate_thermal(circuit, ambient=300.15, t_stop=1, dt=0.01) -> ValidationReport
validate_timing(circuit) -> ValidationReport
validate_candidate(circuit, golden=None) -> ValidationReport
```

## `circuitforge.instruments`

```python
VMM1(integration_time=0.01)
TINY_OSC(sample_rate=50e6, v_full_scale=5.0)
FND2(gate_time=1.0, v_threshold=2.5)
```

Each instrument exposes a `sample(t, v)` method and a `read(target)` or
`measure()` method that returns a `Measurement`.

## `circuitforge.gpu`

```python
get_engine() -> Engine
set_force_cpu(value: bool) -> None
is_gpu_available() -> bool
get_engine_info() -> EngineInfo
benchmark(stop=1024, factor=2, n_iters=3) -> dict
```

## `circuitforge.benchmarks`

```python
run_all_benchmarks() -> list[BenchmarkResult]
```

## `circuitforge.stress`

```python
run_all_stress_tests() -> list[StressResult]
```

## `circuitforge.patterns`

```python
find_repeated_patterns(circuit, min_occurrences=2, max_components_per_pattern=50, max_patterns=20) -> list[DetectedPattern]
extract_pattern_as_chip(circuit, library, pattern, chip_name, description="") -> ChipDefinition
```

## `circuitforge.jobs`

```python
JobQueue(persistence_path=None)
Job(priority, payload, status)
```

## `circuitforge.analysis`

```python
analyze_circuit(circuit) -> CircuitAnalysis
estimate_critical_path(circuit) -> tuple[list, float]
```

## `circuitforge.export`

```python
export_hierarchical(circuit) -> str
export_flat(circuit, max_depth=10) -> str
export_full_electrical(circuit) -> str
export_bom(circuit) -> str
```

## `circuitforge.chips`

```python
save_as_chip(circuit, library, name, port_names, description="") -> ChipDefinition
instantiate_chip(parent, library, name, instance_name, params=None) -> Component
unfold_chip(parent, instance_id) -> int
list_chip_instances(circuit) -> list
```

## `circuitforge.cli`

```python
main(argv: list[str] = None) -> int
```

Subcommands: `info`, `validate`, `simulate`, `export`, `auto-design`,
`benchmark`, `gpu-info`.

## `circuitforge.gui`

```python
run_gui() -> int
```