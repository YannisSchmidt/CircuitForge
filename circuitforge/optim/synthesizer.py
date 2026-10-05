"""
High-level synthesizer (sections 8, 10, 24 of the spec).

The user provides an `AutoDesignSpec` and gets back a `Candidate`
matching the spec.

Currently supported:
- ALU (per-bit bitwise + adder)
- ADDER (ripple-carry)
- MULTIPLIER (array-style, demoed)
- MUX (tree-style, demoed)
- DECODER (binary decoder)

Each category maps to a specific template and golden model.
"""

from __future__ import annotations

from typing import Callable, Dict, Optional

from ..core.circuit import Circuit
from .specification import AutoDesignSpec
from .objectives import ObjectiveSet
from .templates import (
    CircuitTemplate, BitAdderTemplate, BitALUTemplate,
    BitMultiplierTemplate, BitMuxTemplate, BitDecoderTemplate,
)
from .evaluator import Candidate
from .search import SearchConfig, run_evolutionary_search, SearchResult


def _golden_for(category: str, spec: AutoDesignSpec) -> tuple:
    """
    Return (template, input_names, expected_outputs_fn).
    """
    n = int(spec.parameters.get("data_width", 8))
    if category == "ALU":
        t = BitALUTemplate(n_bits=n)
        # Inputs: A[0..n-1], B[0..n-1], OP_SEL[0..2]
        ins = [f"A{i}" for i in range(n)] + [f"B{i}" for i in range(n)] + \
              ["OP_SEL_0", "OP_SEL_1", "OP_SEL_2"]
        def gold(v):
            a = v[:n]
            b = v[n:2*n]
            sel = v[2*n:]
            op = sel[0] | (sel[1] << 1) | (sel[2] << 2)
            if op == 0:
                r = [a[i] & b[i] for i in range(n)]
            elif op == 1:
                r = [a[i] | b[i] for i in range(n)]
            elif op == 2:
                r = [a[i] ^ b[i] for i in range(n)]
            else:
                r = a[:]
            return r
        return t, ins, gold
    if category == "ADDER":
        t = BitAdderTemplate(n_bits=n)
        ins = [f"A{i}" for i in range(n)] + [f"B{i}" for i in range(n)] + ["CIN"]
        def gold_adder(v):
            a = v[:n]
            b = v[n:2*n]
            cin = v[2*n]
            total = 0
            for i in range(n):
                total |= (a[i] << i)
            bv = 0
            for i in range(n):
                bv |= (b[i] << i)
            s = total + bv + cin
            return [s >> i & 1 for i in range(n)] + [(s >> n) & 1]
        return t, ins, gold_adder
    if category == "MULTIPLIER":
        t = BitMultiplierTemplate(n_bits=n)
        ins = [f"A{i}" for i in range(n)] + [f"B{i}" for i in range(n)]
        outs = 2 * n
        def gold_mul(v):
            a = 0
            for i in range(n):
                a |= (v[i] << i)
            b = 0
            for i in range(n):
                b |= (v[n + i] << i)
            p = a * b
            return [(p >> i) & 1 for i in range(outs)]
        return t, ins, gold_mul
    if category == "MUX":
        n_in = int(spec.parameters.get("n_inputs", 4))
        sel_bits = int(spec.parameters.get("sel_bits", 2))
        t = BitMuxTemplate(n_inputs=n_in, sel_bits=sel_bits)
        ins = [f"D{i}" for i in range(n_in)] + [f"S{i}" for i in range(sel_bits)]
        def gold_mux(v):
            sel = 0
            for i in range(sel_bits):
                sel |= (v[n_in + i] << i)
            return [v[sel]]
        return t, ins, gold_mux
    if category == "DECODER":
        t = BitDecoderTemplate(n_bits=n)
        ins = [f"I{i}" for i in range(n)]
        outs = 2 ** n
        def gold_dec(v):
            sel = 0
            for i in range(n):
                sel |= (v[i] << i)
            r = [0] * outs
            r[sel] = 1
            return r
        return t, ins, gold_dec
    raise ValueError(f"unsupported category {category!r}")


def _build_dex() -> tuple:
    return None, None, None


def synthesize_for_spec(
    spec: AutoDesignSpec,
    config: SearchConfig = None,
) -> SearchResult:
    """
    Run a search matching `spec` and return a SearchResult.
    """
    if config is None:
        config = SearchConfig()
    config.seed = spec.seed
    config.expected_outputs_fn = None  # set below
    template, inputs, gold = _golden_for(spec.category, spec)
    config.input_names = inputs
    config.expected_outputs_fn = gold
    return run_evolutionary_search(
        template=template,
        config=config,
        objectives=spec.objectives(),
    )


def auto_design(
    spec: AutoDesignSpec,
    config: SearchConfig = None,
) -> Candidate:
    """
    High-level entry point: design a circuit from a spec.
    Returns the best Candidate found.
    """
    res = synthesize_for_spec(spec, config)
    if res.best is None:
        raise RuntimeError(f"auto_design failed: {res.error or 'no candidate found'}")
    return res.best