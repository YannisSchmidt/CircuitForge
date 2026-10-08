/**
 * The instrument layer: what the workbench measures with.
 *
 * Everything here reads the solver's own state — no instrument re-solves the circuit
 * behind the caller's back, and none of them invents a number the simulation did not
 * produce. Each reading carries the method that produced it, an accuracy class, and
 * what it does not include.
 *
 *   fft.ts        the transform and the windows, with their correction factors
 *   measure.ts    time-domain measurements over adaptively spaced samples
 *   scope.ts      the oscilloscope: channels, capture, cursors, zoom, CSV
 *   spectrum.ts   the spectrum analyzer: span, RBW, scale, markers, peaks, THD
 *   meters.ts     voltmeter, ammeter, wattmeter, thermometer (placed and virtual)
 *   generator.ts  the signal generator, native waveforms and baked PWL tables
 */

export * from './fft.js';
export * from './measure.js';
export * from './scope.js';
export * from './spectrum.js';
export * from './meters.js';
export * from './generator.js';
