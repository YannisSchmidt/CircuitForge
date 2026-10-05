"""
Hierarchical chip library.

A chip is a named sub-circuit that can be reused. A chip has a
public interface (a list of named ports with directions) and an
implementation (an internal Circuit). The internal circuit may
itself use other chips, allowing arbitrary nesting depth.

The package provides:
- `save_as_chip(circuit, library, name, ...)` to extract a chip
- `instantiate_chip(library, name, reference, ...)` to place a
  chip instance in a parent circuit
- `unfold_chip(circuit, library, target_chip)` to replace a chip
  instance by its full implementation (for inspection)
"""
from .hierarchical import (
    save_as_chip, instantiate_chip, unfold_chip, unfold_all,
    ChipInstance, get_chip_definition, list_chip_instances,
)

__all__ = [
    "save_as_chip", "instantiate_chip", "unfold_chip", "unfold_all",
    "ChipInstance", "get_chip_definition", "list_chip_instances",
]
