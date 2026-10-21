import {
  type InteractiveView,
  type Param,
  type ParamValue,
  type Strokes,
  snapped,
  toGrid,
} from '@parallax/contracts';

/**
 * The learner's unsent work on an interactive step (§9), one shape per kind, and its conversion
 * to the response the server parses. A draft starts from what the server recorded last, so a
 * wrong answer keeps the work, or from the revealed answer once the solution is shown.
 */
export type InteractiveDraft =
  | { kind: 'categorize'; placed: Record<string, string> }
  | { kind: 'fill_blanks'; filled: Record<string, string> }
  | { kind: 'label_diagram'; filled: Record<string, string> }
  | { kind: 'plot_points'; at: Record<string, [number, number]> }
  | { kind: 'sketch_graph'; ys: number[] }
  | { kind: 'hotspot'; picked: string[] }
  | { kind: 'grid'; cells: [number, number][] }
  | { kind: 'manipulate' | 'explore'; values: Record<string, ParamValue> }
  | { kind: 'drawing'; strokes: Strokes; undone: Strokes; description: string };

const record = (r: unknown): Record<string, unknown> =>
  r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
const strings = (r: unknown) =>
  Object.fromEntries(Object.entries(record(r)).filter(([, v]) => typeof v === 'string')) as Record<
    string,
    string
  >;
const pair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');

/** A parameter's starting value. */
export const initialValue = (p: Param): ParamValue => p.initial;

/** The draft for `view`, from a recorded response (or a revealed answer), else blank. */
export function interactiveDraft(view: InteractiveView, response: unknown): InteractiveDraft {
  switch (view.kind) {
    case 'categorize':
      return { kind: view.kind, placed: strings(response) };
    case 'fill_blanks':
    case 'label_diagram':
      return { kind: view.kind, filled: strings(response) };
    case 'plot_points': {
      const recorded = record(response);
      const at: Record<string, [number, number]> = {};
      for (const p of view.points) {
        const v = recorded[p.id];
        if (pair(v)) at[p.id] = v;
        else if (p.start) at[p.id] = p.start;
      }
      return { kind: view.kind, at };
    }
    case 'sketch_graph': {
      const ys =
        Array.isArray(response) &&
        response.length === view.xs.length &&
        response.every((y) => typeof y === 'number')
          ? (response as number[])
          : view.xs.map(() => view.start);
      return { kind: view.kind, ys };
    }
    case 'hotspot':
      return {
        kind: view.kind,
        picked: Array.isArray(response) ? response.filter((v) => typeof v === 'string') : [],
      };
    case 'grid':
      return {
        kind: view.kind,
        cells: Array.isArray(response) ? (response.filter(pair) as [number, number][]) : [],
      };
    case 'manipulate':
    case 'explore': {
      const recorded = record(response);
      const values: Record<string, ParamValue> = {};
      for (const p of view.params) {
        const v = recorded[p.name];
        values[p.name] =
          p.kind === 'point' ? (pair(v) ? v : p.initial) : typeof v === 'number' ? v : p.initial;
      }
      return { kind: view.kind, values };
    }
    case 'drawing': {
      const r = record(response);
      return {
        kind: view.kind,
        strokes: Array.isArray(r.strokes) ? (r.strokes as Strokes) : [],
        undone: [],
        description: typeof r.description === 'string' ? r.description : '',
      };
    }
  }
}

/**
 * The value nearest `v` that a control from `lo` to `hi` in steps of `step` offers. Its top is
 * the last grid point at or below `hi`, not `hi`: the server refuses values off the grid.
 */
function onControl(v: number, lo: number, hi: number, step: number): number {
  const last = toGrid(lo + Math.floor((hi - lo) / step + 1e-9) * step, lo, step);
  return Math.min(last, Math.max(lo, toGrid(v, lo, step)));
}

/** A parameter's value as its control sends it: on its grid and in its range. */
export function snapParam(p: Param, v: ParamValue): ParamValue {
  if (p.kind === 'point') {
    const [x, y] = Array.isArray(v) ? v : p.initial;
    return [onControl(x, p.x[0], p.x[1], p.step), onControl(y, p.y[0], p.y[1], p.step)];
  }
  return onControl(typeof v === 'number' ? v : p.initial, p.min, p.max, p.step);
}

export type Built = { ok: true; response: unknown } | { ok: false; message: string };

/** The response to send, or what is still missing. */
export function interactiveResponse(view: InteractiveView, draft: InteractiveDraft): Built {
  const missing = (message: string): Built => ({ ok: false, message });
  switch (draft.kind) {
    case 'categorize':
      return view.kind === 'categorize' && view.items.every((i) => draft.placed[i.id])
        ? { ok: true, response: draft.placed }
        : missing('Sort every item into a group before checking.');
    case 'fill_blanks':
    case 'label_diagram': {
      const slots =
        view.kind === 'fill_blanks'
          ? view.gaps
          : view.kind === 'label_diagram'
            ? view.targets.map((t) => t.id)
            : [];
      const empty = slots.some((s) => !draft.filled[s]?.trim());
      if (empty) {
        return missing(
          draft.kind === 'fill_blanks'
            ? 'Fill every gap before checking.'
            : 'Put a label on every target before checking.',
        );
      }
      return { ok: true, response: Object.fromEntries(slots.map((s) => [s, draft.filled[s]])) };
    }
    case 'plot_points':
      return view.kind === 'plot_points' && view.points.every((p) => draft.at[p.id])
        ? { ok: true, response: draft.at }
        : missing('Place every point before checking.');
    case 'sketch_graph':
      return { ok: true, response: draft.ys.map((y) => snapped(y)) };
    case 'hotspot':
      return draft.picked.length > 0
        ? { ok: true, response: draft.picked }
        : missing('Choose a region before checking.');
    case 'grid':
      return { ok: true, response: draft.cells };
    case 'manipulate':
    case 'explore': {
      const params = view.kind === 'manipulate' || view.kind === 'explore' ? view.params : [];
      return {
        ok: true,
        response: Object.fromEntries(
          params.map((p) => [p.name, snapParam(p, draft.values[p.name] ?? initialValue(p))]),
        ),
      };
    }
    case 'drawing':
      return draft.strokes.length > 0 || draft.description.trim() !== ''
        ? { ok: true, response: { strokes: draft.strokes, description: draft.description } }
        : missing('Draw something or describe your drawing first.');
  }
}

const mixed = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A draft part way from `from` to `to` (t from 0 to 1), for moving a revealed answer into place:
 * points, sketched heights and parameter values travel; tokens, regions and cells change at once.
 */
export function mixDraft(
  from: InteractiveDraft,
  to: InteractiveDraft,
  t: number,
): InteractiveDraft {
  if (t >= 1 || from.kind !== to.kind) return to;
  if (from.kind === 'plot_points' && to.kind === 'plot_points') {
    const at: Record<string, [number, number]> = {};
    for (const [id, end] of Object.entries(to.at)) {
      const start = from.at[id];
      at[id] = start ? [mixed(start[0], end[0], t), mixed(start[1], end[1], t)] : end;
    }
    return { kind: to.kind, at };
  }
  if (from.kind === 'sketch_graph' && to.kind === 'sketch_graph') {
    return { kind: to.kind, ys: to.ys.map((y, i) => mixed(from.ys[i] ?? y, y, t)) };
  }
  if (from.kind === 'manipulate' && to.kind === 'manipulate') {
    const values: Record<string, ParamValue> = {};
    for (const [name, end] of Object.entries(to.values)) {
      const start = from.values[name];
      values[name] =
        Array.isArray(end) && Array.isArray(start)
          ? [mixed(start[0], end[0], t), mixed(start[1], end[1], t)]
          : typeof end === 'number' && typeof start === 'number'
            ? mixed(start, end, t)
            : end;
    }
    return { kind: to.kind, values };
  }
  return to;
}
