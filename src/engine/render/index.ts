/**
 * Schematic rendering: geometry, layout, view, drawing backends.
 *
 * Exported as a namespace from the engine barrel (`render.layoutCircuit`,
 * `render.renderToSvg`) rather than flattened into it, because the shapes here —
 * `Point`, `Bounds`, `Theme`, `view` — are renderer vocabulary and would collide
 * with the core geometry types of the same name. Keeping them namespaced is what
 * lets a caller read `render.Point` and know which module it came from.
 */

export * from './types.js';
export * from './theme.js';
export * from './view.js';
export * from './routing.js';
export * from './layout.js';
export * from './backend.js';
export * from './canvas.js';
export * from './draw.js';

import type { ChipLibrary } from '../core/chip.js';
import type { Circuit } from '../core/circuit.js';
import type { Library } from '../core/library.js';
import { layoutCircuit, type LayoutOptions } from './layout.js';
import { renderToSvg, type DrawOptions, type DrawStats } from './draw.js';
import { fitBounds, view as makeView, type Viewport, type ViewTransform } from './view.js';
import type { SheetLayout } from './types.js';

export interface RenderCircuitOptions extends LayoutOptions {
  viewport?: Viewport;
  /** An explicit view; when absent the sheet is fitted to the viewport. */
  view?: ViewTransform;
  draw?: Partial<Omit<DrawOptions, 'view' | 'viewport'>>;
}

/**
 * Lay out a circuit and render it to SVG in one call.
 *
 * The convenience path for a report, an export or a test: it lays the sheet out,
 * fits it to the viewport unless a view was given, draws it, and returns the layout
 * alongside the document so a caller can quote the geometry it was drawn from.
 */
export function renderCircuitToSvg(
  circuit: Circuit,
  lib: Library,
  chips: ChipLibrary | undefined,
  options: RenderCircuitOptions = {},
): { svg: string; layout: SheetLayout; stats: DrawStats; view: ViewTransform } {
  const layout = layoutCircuit(circuit, lib, chips, options);
  const viewport = options.viewport ?? { width: 1600, height: 1000 };
  const v = options.view ?? fitBounds(layout.bounds, viewport, 60);
  const { svg, stats } = renderToSvg(layout, { view: v, viewport, ...options.draw });
  return { svg, layout, stats, view: v };
}

/** Lay out a circuit without drawing it — the geometry only. */
export function layoutOf(circuit: Circuit, lib: Library, chips: ChipLibrary | undefined, options: LayoutOptions = {}): SheetLayout {
  return layoutCircuit(circuit, lib, chips, options);
}

export { makeView };
