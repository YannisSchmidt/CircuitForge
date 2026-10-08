# Physics

The equations this engine actually computes, per device, with what each omits. Nothing
here is aspirational: every entry corresponds to a model card in the component library,
and the card is what `circuitforge list`, the inspector's *Model* tab and
`circuitforge validate` print.

Accuracy classes mean:

- **REALISTIC** — the model reproduces measured device behaviour inside its stated
  validity range, to the tolerance stated.
- **APPROXIMATED** — the model captures the first-order behaviour with documented
  simplifications.
- **IDEALIZED** — the model is an ideal element; real behaviour deviates in known ways.
- **NOT_MODELED** — the phenomenon is not computed at all. It is never faked.

## Passive

**Resistor** — `I = V / R(T)` with `R(T) = R₀ · (1 + tc1·ΔT + tc2·ΔT²)`. Default
`tc1 = 100 ppm/°C`, which is why a divider's midpoint is 7.999999995 V rather than
exactly 8 V on a 12 V rail with 1 kΩ and 2 kΩ. Linear, temperature-dependent, no
voltage coefficient, no noise beyond the declared thermal-noise model.

**Capacitor** — `I = C·dV/dt` through a companion model, with optional series resistance
and a voltage coefficient where declared. No dielectric absorption, no piezoelectric
effect, no DC bias derating.

**Inductor** — `V = L·dI/dt` as an MNA current unknown, with series resistance. No core
saturation, no hysteresis, no frequency-dependent losses.

**Potentiometer / transformer** — implemented as the resistive tap and the coupled
inductor pair they are; the transformer has no core model, so no saturation and no
hysteresis loss.

## Sources

**DC, AC, arbitrary, clock, sine, square, triangle, noise** — ideal sources with the
declared internal resistance where one is given. The arbitrary source evaluates a
user-supplied waveform table with linear interpolation between points; it does not
extrapolate beyond the table, and says so.

Noise sources produce band-limited pseudo-random waveforms from a seeded generator: the
spectrum is flat to the declared bandwidth and the seed makes a run reproducible. It is
not a physical noise model of a specific device.

## Semiconductors

**Diode** — Shockley: `I = Is·(exp(V/(n·Vt)) − 1)` with `Vt = kT/q`, series resistance,
junction capacitance `Cj0·(1 − V/Vj)^(−M)` and diffusion capacitance `τt·dI/dV`. Reverse
breakdown is a declared knee, not an avalanche model. Recombination current, high-level
injection and self-heating beyond the declared thermal node are omitted.

**LED** — the diode model with a forward voltage appropriate to the declared colour, plus
a light-output figure reported as **NOT_MODELED**: the electrical behaviour is computed
(a red LED on 5 V through 150 Ω settles at 2.29 V and 90.4 mW total dissipation), the
photometry is not.

**Photodiode** — the diode model with a photocurrent term proportional to declared
irradiance. Spectral response is a single scalar responsivity, not a curve.

**BJT** — a Gummel–Poon subset: transport current from `Is`, forward and reverse gains
`Bf`/`Br`, base-width modulation through `Vaf`/`Var` and the normalized base charge `qb`,
knee currents `Ikf`/`Ikr`, base and collector resistances, and `Cje`/`Cjc` with grading
coefficients. Omitted: excess phase, substrate network, avalanche multiplication,
temperature-dependent gain beyond the declared coefficients.

**NMOS / PMOS** — a Shichman–Hodges class model with a softplus-smoothed transition
between cutoff, linear and saturation regions, channel-length modulation `Lambda`,
body effect through `Gamma`, and overlap capacitances `Cgso`/`Cgdo`. Omitted:
short-channel effects, velocity saturation, gate tunnelling, charge partitioning,
subthreshold slope as a physical quantity (it is a smoothing parameter), and layout
parasitics.

**Controlled sources** — VCVS, CCVS, VCCS, CCCS with the declared gain. Ideal: infinite
input impedance, zero output impedance, no bandwidth limit.

## Electromechanical

**Switch, button, relay** — a resistance that changes state: closed `Ron`, open `Roff`,
with the declared transition time for a relay coil and its coil inductance. Contact
bounce, contact resistance growth and coil heating beyond the declared thermal node are
not modelled.

## Digital

**Gate** — a behavioural truth-table element at level 0, with declared propagation
delays (`tphl`, `tplh`) used by the timing analysis, and an optional expansion to a CMOS
transistor network (`cmos_static`) for level 1 and 2. A gate declared with delay 0 means
the model does not model delay; a critical path over such elements is a lower bound and
is reported as one.

**Register (DFF, D latch)** — level-0 state with `setup` time declared, clock and
asynchronous reset, initial state 0/1/unknown. Hold time, metastability and recovery are
reported as NOT_MODELED: a simulator that invented a metastability window would be
guessing.

## Thermal

Junction temperature from `Tj = Ta + P·(Rth_jc + Rth_ca)`, extended to an RC network when
transient thermal is requested. `Rth` values are declared per package, not computed from
geometry; there is no conduction model of a board, no convection correlation and no
radiation. Self-heating is coupled back into the device parameters that declare a
temperature coefficient (a device dissipating 980.8 mW with the default resistances
reaches 223.15 °C from a 27 °C ambient, which is reported as out of range rather than
clamped).

## Numerical method

Newton-Raphson on the MNA system, with a gmin ladder and source stepping for convergence
robustness. Convergence is reported with the iteration count, the worst voltage error and
the node it occurred at, and a solve that did not converge says so in the report and in
the interface. Raising `gmin` or the iteration cap to force convergence is deliberately
not done: a converged-looking answer from a diverged solve is worse than an error.
