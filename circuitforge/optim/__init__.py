"""Optimization, synthesis, multi-objective search (sections 8-13)."""
from .objectives import (
    Objective, ObjectiveSpec, ObjectiveSet,
    SPEED, AREA, POWER, TEMPERATURE, STABILITY, MEMORY,
    profile_fastest, profile_smallest, profile_low_power,
    profile_low_temperature, profile_most_stable, profile_balanced,
    get_profile, PROFILES,
)
from .specification import AutoDesignSpec, ALU_SPEC, RAM_SPEC, MULTIPLIER_SPEC
from .templates import (
    CircuitTemplate, Gene, BitAdderTemplate, BitALUTemplate,
    BitMultiplierTemplate, BitMuxTemplate, BitDecoderTemplate,
)
from .evaluator import (
    Candidate, EvaluationResult, evaluate_candidate,
    evaluate_logical, evaluate_electrical, evaluate_thermal,
    score_candidate, filter_logical, filter_electrical,
)
from .search import (
    SearchConfig, SearchResult, SearchLogger,
    run_evolutionary_search, filter_level,
)
from .synthesizer import auto_design, synthesize_for_spec

__all__ = [
    "Objective", "ObjectiveSpec", "ObjectiveSet",
    "SPEED", "AREA", "POWER", "TEMPERATURE", "STABILITY", "MEMORY",
    "profile_fastest", "profile_smallest", "profile_low_power",
    "profile_low_temperature", "profile_most_stable", "profile_balanced",
    "get_profile", "PROFILES",
    "AutoDesignSpec", "ALU_SPEC", "RAM_SPEC", "MULTIPLIER_SPEC",
    "CircuitTemplate", "Gene", "BitAdderTemplate", "BitALUTemplate",
    "BitMultiplierTemplate", "BitMuxTemplate", "BitDecoderTemplate",
    "Candidate", "EvaluationResult", "evaluate_candidate",
    "evaluate_logical", "evaluate_electrical", "evaluate_thermal",
    "score_candidate", "filter_logical", "filter_electrical",
    "SearchConfig", "SearchResult", "SearchLogger",
    "run_evolutionary_search", "filter_level",
    "auto_design", "synthesize_for_spec",
]