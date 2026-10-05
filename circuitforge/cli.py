"""
Command-line interface for CircuitForge.

Usage examples:
    python -m circuitforge.cli info project.json
    python -m circuitforge.cli validate project.json
    python -m circuitforge.cli simulate project.json --logic
    python -m circuitforge.cli export project.json --out schematic.txt
    python -m circuitforge.cli auto-design --category adder --bits 4
    python -m circuitforge.cli benchmark
    python -m circuitforge.cli run-benchmarks --output results.json
"""

from __future__ import annotations

import argparse
import json
import sys
import os
import time
from typing import List, Optional, Dict, Any


def cmd_info(args) -> int:
    from .io.serialize import project_from_json
    with open(args.path) as f:
        s = f.read()
    c = project_from_json(s)
    print(f"Circuit: {c.name}")
    print(f"Components: {len(c.components)}")
    print(f"Nets: {len(c.nets)}")
    print(f"Ports: {len(c.ports)}")
    print(f"Library primitives: {len(c.library._primitives)}")
    return 0


def cmd_validate(args) -> int:
    from .io.serialize import project_from_json
    from .validation import validate_logic, validate_electrical, validate_thermal, validate_timing
    from .optim.templates import BitAdderTemplate
    with open(args.path) as f:
        s = f.read()
    c = project_from_json(s)
    # We can't recover the golden function from the project, so we
    # run a structural validation only.
    print(f"Validating {c.name}...")
    t = validate_timing(c)
    print(f"  timing: {t.summary()}")
    return 0 if t.n_failed == 0 else 1


def cmd_simulate(args) -> int:
    from .io.serialize import project_from_json
    from .sim.logic import simulate_logic, LogicState
    from .core.ids import PortId
    with open(args.path) as f:
        s = f.read()
    c = project_from_json(s)
    if args.logic:
        # Build inputs from LOGIC_INPUTs
        from .core.ids import NetId
        inputs = {}
        for comp in c._components.values():
            if comp.spec.name == "LOGIC_INPUT":
                for pid in comp.ports:
                    port = c.ports[PortId(int(pid))]
                    if port.net is not None:
                        c._nets[NetId(int(port.net))].name = comp.reference
                        inputs[comp.reference] = LogicState(1 if args.all_ones else 0)
        t0 = time.perf_counter()
        result = simulate_logic(c, inputs)
        elapsed = time.perf_counter() - t0
        print(f"Logic simulation: {elapsed * 1000:.2f} ms")
        print(f"  state: {result.net_states}")
        # Print outputs
        for comp in c._components.values():
            if comp.spec.name == "LOGIC_OUTPUT":
                for pid in comp.ports:
                    port = c.ports[PortId(int(pid))]
                    if port.net is not None:
                        v = result.net_states.get(int(port.net), LogicState.LOGIC_X)
                        print(f"  {comp.reference}: {v.name}")
    return 0


def cmd_export(args) -> int:
    from .io.serialize import project_from_json
    from .export.schematic import export_hierarchical, export_bom
    with open(args.path) as f:
        s = f.read()
    c = project_from_json(s)
    if args.format == "schematic":
        out = export_hierarchical(c)
    elif args.format == "bom":
        out = export_bom(c)
    else:
        print(f"Unknown format: {args.format}")
        return 1
    if args.out:
        with open(args.out, "w") as f:
            f.write(out)
    else:
        print(out)
    return 0


def cmd_auto_design(args) -> int:
    from .optim.specification import (
        AutoDesignSpec, ALU_SPEC, MULTIPLIER_SPEC,
    )
    from .optim.synthesizer import auto_design
    from .optim.search import SearchConfig
    if args.category == "adder":
        from .optim.templates import BitAdderTemplate
        t = BitAdderTemplate(n_bits=args.bits)
        spec = AutoDesignSpec(
            category="ADDER",
            description=f"{args.bits}-bit adder",
            parameters={"n_bits": args.bits},
            target_operations=[],
            optimization_profile="balanced",
        )
    elif args.category == "alu":
        spec = ALU_SPEC(args.bits)
    elif args.category == "multiplier":
        spec = MULTIPLIER_SPEC(args.bits)
    else:
        print(f"Unknown category: {args.category}")
        return 1
    cfg = SearchConfig(population_size=8, n_generations=4,
                       time_budget_s=10, seed=args.seed)
    cand = auto_design(spec, cfg)
    print(f"Auto-design best: {cand.fingerprint}")
    print(f"  components: {cand.evaluation.n_components}")
    print(f"  score: {cand.evaluation.score:.4f}")
    return 0


def cmd_benchmark(args) -> int:
    from .benchmarks import run_all_benchmarks
    results = run_all_benchmarks()
    for r in results:
        print(r.summary())
    if args.output:
        with open(args.output, "w") as f:
            json.dump([{
                "name": r.name, "passed": r.passed,
                "elapsed_s": r.elapsed_s, "memory_kb": r.memory_kb,
                "notes": r.notes, "error": r.error,
            } for r in results], f, indent=2)
    return 0


def cmd_gpu_info(args) -> int:
    from .gpu import get_engine_info, is_gpu_available
    info = get_engine_info()
    print(f"Backend: {info.name}")
    print(f"GPU available: {is_gpu_available()}")
    print(f"Version: {info.version}")
    print(f"Devices: {info.n_devices}")
    for n in info.device_names:
        print(f"  - {n}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="circuitforge",
        description="CircuitForge command-line interface",
    )
    sub = parser.add_subparsers(dest="command")

    p_info = sub.add_parser("info", help="Display project info")
    p_info.add_argument("path")

    p_val = sub.add_parser("validate", help="Validate a project")
    p_val.add_argument("path")

    p_sim = sub.add_parser("simulate", help="Simulate a project")
    p_sim.add_argument("path")
    p_sim.add_argument("--logic", action="store_true")
    p_sim.add_argument("--all-ones", action="store_true")

    p_exp = sub.add_parser("export", help="Export a project")
    p_exp.add_argument("path")
    p_exp.add_argument("--format", choices=["schematic", "bom"],
                        default="schematic")
    p_exp.add_argument("--out")

    p_ad = sub.add_parser("auto-design", help="Run auto-design")
    p_ad.add_argument("--category", choices=["adder", "alu", "multiplier"],
                       default="adder")
    p_ad.add_argument("--bits", type=int, default=4)
    p_ad.add_argument("--seed", type=int, default=0)

    p_bm = sub.add_parser("benchmark", help="Run benchmarks")
    p_bm.add_argument("--output", help="JSON output file")

    sub.add_parser("gpu-info", help="Display GPU information")

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0

    handlers = {
        "info": cmd_info,
        "validate": cmd_validate,
        "simulate": cmd_simulate,
        "export": cmd_export,
        "auto-design": cmd_auto_design,
        "benchmark": cmd_benchmark,
        "gpu-info": cmd_gpu_info,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())