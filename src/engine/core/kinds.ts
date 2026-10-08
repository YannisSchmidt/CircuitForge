/**
 * Element kinds — the vocabulary shared by the library (authoring side) and the
 * flattened netlist (execution side).
 *
 * Keeping them as integer constants (not strings) matters: the netlist stores one
 * `Uint8Array` of kinds, and the AC/DC/transient loops switch on these values.
 * Every new device gets a new kind here plus an implementation in `sim/elements`.
 */

export const enum Kind {
  Unknown = 0,
  // --- two-terminal passives ---------------------------------------------
  Resistor = 1,
  Capacitor = 2,
  Inductor = 3,
  Potentiometer = 4,
  Transformer = 5,
  NtcThermistor = 6,
  Varistor = 7,
  // --- semiconductors ----------------------------------------------------
  Diode = 10,
  Led = 11,
  Photodiode = 12,
  Bjt = 13,
  Mosfet = 14,
  Jfet = 15,
  // --- switching ---------------------------------------------------------
  Switch = 20,
  PushButton = 21,
  Relay = 22,
  // --- sources -----------------------------------------------------------
  VoltageSource = 30,
  CurrentSource = 31,
  // --- controlled sources ------------------------------------------------
  Vcvs = 35,
  Vccs = 36,
  Ccvs = 37,
  Cccs = 38,
  // --- digital behavioural ----------------------------------------------
  LogicGate = 45,
  LogicBuf = 46,
  TriState = 47,
  DFlipFlop = 48,
  DLatch = 49,
  Mux = 50,
  Demux = 51,
  // --- boundary / infrastructure ----------------------------------------
  Ground = 60,
  Port = 61,
  Probe = 62,
  Wattmeter = 63,
  AmmeterShunt = 64,
  Heatsink = 65,
  ThermalPad = 66,
  NoiseSource = 67,
}

export const KIND_NAME: Record<number, string> = {
  [Kind.Resistor]: 'RESISTOR',
  [Kind.Capacitor]: 'CAPACITOR',
  [Kind.Inductor]: 'INDUCTOR',
  [Kind.Potentiometer]: 'POTENTIOMETER',
  [Kind.Transformer]: 'TRANSFORMER',
  [Kind.NtcThermistor]: 'NTC_THERMISTOR',
  [Kind.Varistor]: 'VARISTOR',
  [Kind.Diode]: 'DIODE',
  [Kind.Led]: 'LED',
  [Kind.Photodiode]: 'PHOTODIODE',
  [Kind.Bjt]: 'BJT',
  [Kind.Mosfet]: 'MOSFET',
  [Kind.Jfet]: 'JFET',
  [Kind.Switch]: 'SWITCH',
  [Kind.PushButton]: 'PUSH_BUTTON',
  [Kind.Relay]: 'RELAY',
  [Kind.VoltageSource]: 'VOLTAGE_SOURCE',
  [Kind.CurrentSource]: 'CURRENT_SOURCE',
  [Kind.Vcvs]: 'VCVS',
  [Kind.Vccs]: 'VCCS',
  [Kind.Ccvs]: 'CCVS',
  [Kind.Cccs]: 'CCCS',
  [Kind.LogicGate]: 'LOGIC_GATE',
  [Kind.LogicBuf]: 'LOGIC_BUFFER',
  [Kind.TriState]: 'TRISTATE',
  [Kind.DFlipFlop]: 'D_FLIP_FLOP',
  [Kind.DLatch]: 'D_LATCH',
  [Kind.Mux]: 'MULTIPLEXER',
  [Kind.Demux]: 'DEMULTIPLEXER',
  [Kind.Ground]: 'GROUND',
  [Kind.Port]: 'PORT',
  [Kind.Probe]: 'PROBE',
  [Kind.Wattmeter]: 'WATTMETER',
  [Kind.AmmeterShunt]: 'AMMETER',
  [Kind.Heatsink]: 'HEATSINK',
  [Kind.ThermalPad]: 'THERMAL_PAD',
  [Kind.NoiseSource]: 'NOISE_SOURCE',
};

/** SPICE letter for each kind (used by the SPICE netlist exporter). */
export const KIND_SPICE: Record<number, string> = {
  [Kind.Resistor]: 'R',
  [Kind.Capacitor]: 'C',
  [Kind.Inductor]: 'L',
  [Kind.Potentiometer]: 'R',
  [Kind.Transformer]: 'L',
  [Kind.NtcThermistor]: 'R',
  [Kind.Varistor]: 'R',
  [Kind.Diode]: 'D',
  [Kind.Led]: 'D',
  [Kind.Photodiode]: 'D',
  [Kind.Bjt]: 'Q',
  [Kind.Mosfet]: 'M',
  [Kind.Jfet]: 'J',
  [Kind.Switch]: 'S',
  [Kind.PushButton]: 'S',
  [Kind.Relay]: 'X',
  [Kind.VoltageSource]: 'V',
  [Kind.CurrentSource]: 'I',
  [Kind.NoiseSource]: 'V',
  [Kind.Vcvs]: 'E',
  [Kind.Vccs]: 'G',
  [Kind.Ccvs]: 'H',
  [Kind.Cccs]: 'F',
  [Kind.LogicGate]: 'X',
  [Kind.LogicBuf]: 'X',
  [Kind.TriState]: 'X',
  [Kind.DFlipFlop]: 'X',
  [Kind.DLatch]: 'X',
  [Kind.Mux]: 'X',
  [Kind.Demux]: 'X',
  [Kind.Ground]: '',
  [Kind.Port]: '',
  [Kind.Probe]: '',
  [Kind.Wattmeter]: 'X',
  [Kind.AmmeterShunt]: 'V',
  [Kind.Heatsink]: '*',
  [Kind.ThermalPad]: '*',
};

/** Element kinds that introduce a branch current unknown in MNA. */
export const KIND_IS_BRANCH = new Set<number>([
  Kind.VoltageSource,
  Kind.Inductor,
  Kind.Vcvs,
  Kind.Ccvs,
  Kind.Ccvs,
  Kind.NoiseSource,
]);

/** Element kinds with no electrical effect (instruments / annotations). */
export const KIND_IS_OBSERVER = new Set<number>([
  Kind.Probe,
  Kind.Wattmeter,
  Kind.Ground,
  Kind.Port,
  Kind.Heatsink,
  Kind.ThermalPad,
]);
