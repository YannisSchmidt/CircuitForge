"""Tests for the optimization and synthesis engine."""

import unittest

from circuitforge.optim import (
    BitAdderTemplate, BitMuxTemplate, BitDecoderTemplate,
    AutoDesignSpec, SearchConfig, SearchResult,
    auto_design, synthesize_for_spec,
    profile_balanced, profile_fastest, get_profile,
    Candidate, EvaluationResult,
    filter_logical, filter_electrical,
)


class TestProfiles(unittest.TestCase):

    def test_balanced_weights_sum_to_one(self):
        p = profile_balanced()
        self.assertAlmostEqual(p.total_weight(), 1.0, places=4)

    def test_fastest_weights(self):
        p = profile_fastest()
        self.assertGreater(p.weights()["speed"], 0.4)

    def test_get_profile_unknown(self):
        p = get_profile("DOES_NOT_EXIST")
        self.assertAlmostEqual(p.total_weight(), 1.0, places=4)


class TestTemplates(unittest.TestCase):

    def test_adder_template(self):
        t = BitAdderTemplate(n_bits=4)
        self.assertEqual(len(t.genes()), 1)
        c = t.instantiate({"n_bits": 4})
        self.assertGreater(len(c), 0)
        # Just check it's a sensible number (no exact count, depends
        # on future tweaks to the template)
        self.assertGreater(len(c), 10)
        self.assertLess(len(c), 100)

    def test_mux_template(self):
        t = BitMuxTemplate(n_inputs=4)
        c = t.instantiate({"n_inputs": 4, "sel_bits": 2})
        self.assertGreater(len(c), 0)

    def test_decoder_template(self):
        t = BitDecoderTemplate(n_bits=2)
        c = t.instantiate({"n_bits": 2})
        # 2 inputs, 4 outputs, 4 AND gates per output (3-input: 2 per output)
        self.assertGreater(len(c), 0)


class TestSynthesis(unittest.TestCase):

    def test_synthesize_4bit_adder(self):
        spec = AutoDesignSpec(
            category="ADDER",
            parameters={"data_width": 4},
            optimization_profile="FASTEST",
            seed=42,
            max_components=1000,
        )
        config = SearchConfig(
            population_size=8,
            n_generations=2,
            max_vectors=8,
            time_budget_s=10,
            seed=42,
        )
        result = synthesize_for_spec(spec, config)
        self.assertIsInstance(result, SearchResult)
        self.assertIsNotNone(result.best)
        self.assertGreater(result.candidates_tested, 0)

    def test_auto_design_returns_candidate(self):
        spec = AutoDesignSpec(
            category="ADDER",
            parameters={"data_width": 4},
            optimization_profile="FASTEST",
            seed=42,
            max_components=1000,
        )
        config = SearchConfig(
            population_size=8,
            n_generations=2,
            max_vectors=8,
            time_budget_s=10,
            seed=42,
        )
        cand = auto_design(spec, config)
        self.assertIsInstance(cand, Candidate)
        self.assertIn("n_bits", cand.genes)
        self.assertGreater(cand.evaluation.n_components, 0)

    def test_synthesize_alu(self):
        spec = AutoDesignSpec(
            category="ALU",
            parameters={"data_width": 4},
            optimization_profile="BALANCED",
            seed=42,
            max_components=5000,
        )
        config = SearchConfig(
            population_size=6,
            n_generations=1,
            max_vectors=4,
            time_budget_s=10,
            seed=42,
        )
        result = synthesize_for_spec(spec, config)
        self.assertIsInstance(result, SearchResult)


class TestSearchResultExplanation(unittest.TestCase):

    def test_why_explanation(self):
        from circuitforge.optim.search import SearchResult
        spec = AutoDesignSpec(
            category="ADDER",
            parameters={"data_width": 4},
            optimization_profile="BALANCED",
            seed=1,
        )
        config = SearchConfig(
            population_size=4, n_generations=1, max_vectors=4,
            time_budget_s=5, seed=1,
        )
        result = synthesize_for_spec(spec, config)
        if result.best is None:
            self.skipTest("search returned no candidate")
        # Create a dummy "worse" candidate by re-using result.best
        # but constructing a separate SearchResult with a worse best.
        worse_cand = Candidate(
            template_name=result.best.template_name,
            genes=dict(result.best.genes),
            circuit=result.best.circuit,
            fingerprint=result.best.fingerprint,
            evaluation=EvaluationResult(
                n_components=result.best.evaluation.n_components + 50,
                delay_ns=result.best.evaluation.delay_ns + 5,
                power_w=result.best.evaluation.power_w + 0.5,
                score=result.best.evaluation.score + 100,
                tests_passed=result.best.evaluation.tests_passed,
                tests_failed=result.best.evaluation.tests_failed,
                tests_total=result.best.evaluation.tests_total,
            ),
        )
        worse = SearchResult(
            best=worse_cand,
            best_score=worse_cand.evaluation.score,
            generations=1, candidates_tested=1,
        )
        explanation = result.why(worse)
        self.assertIn("WHY THIS DESIGN", explanation)


if __name__ == "__main__":
    unittest.main()