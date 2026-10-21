import type { z } from 'zod';
import {
  gapsIn,
  type InteractiveStep,
  type InteractiveView,
  interactiveResponse,
  onGrid,
  type ParamValue,
  paramAccepts,
  paramScope,
  perfectMatching,
  type SketchGraphStep,
  sampleXs,
  snapInside,
} from './exerciseInteractive';
import type { Judgement, ParsedResponse } from './exerciseRules';
import { holds, quantityValue } from './expression';
import { parseNumber } from './numberText';

/**
 * The rules of the interactive step kinds (§9): what a student sees, which responses a check
 * accepts, how a response is judged, and the answer Show solution moves into place. Pure
 * functions shared by the server, which judges, and the editor's preview, which tries a step
 * the author is writing. `exerciseRules.ts` dispatches here for these kinds.
 */

type Order = <T>(list: T[], shuffle: boolean) => T[];
type FillBlanks = Extract<InteractiveStep, { kind: 'fill_blanks' }>;
type XY = [number, number];

const labelled = (list: { id: string; label: string }[]) =>
  list.map(({ id, label }) => ({ id, label }));
const anyOf = (a: string | string[]) => (Array.isArray(a) ? a : [a]);

/** A point's position as [x, y]: on a number line a single number x stands at [x, 0]. */
export const pointAt = (v: number | XY): XY => (typeof v === 'number' ? [v, 0] : v);

/** Where a sketch's handles start: `start`, else 0, else the middle of the y range. */
export function sketchStart(step: Pick<SketchGraphStep, 'start' | 'scene'>): number {
  if (step.start !== undefined) return step.start;
  const [lo, hi] = step.scene.y;
  return lo <= 0 && hi >= 0 ? 0 : (lo + hi) / 2;
}

export function viewInteractive(step: InteractiveStep, order: Order): InteractiveView {
  switch (step.kind) {
    case 'categorize':
      return {
        kind: step.kind,
        categories: labelled(step.categories),
        items: labelled(order(step.items, step.shuffle)),
      };
    case 'fill_blanks':
      return {
        kind: step.kind,
        text: step.text,
        gaps: gapsIn(step.text),
        ...(step.tiles && { tiles: labelled(order(step.tiles, step.shuffle)) }),
        reuse: step.reuse,
      };
    case 'label_diagram':
      return {
        kind: step.kind,
        scene: step.scene,
        targets: step.targets.map(({ id, at }) => ({ id, at })),
        labels: labelled(order(step.labels, step.shuffle)),
        reuse: step.reuse,
      };
    case 'plot_points':
      return {
        kind: step.kind,
        scene: step.scene,
        line: step.line,
        snap: step.snap,
        points: step.points.map((p) => ({
          id: p.id,
          label: p.label,
          ...(p.start !== undefined && { start: pointAt(p.start) }),
        })),
      };
    case 'sketch_graph':
      return { kind: step.kind, scene: step.scene, xs: sampleXs(step), start: sketchStart(step) };
    case 'hotspot':
      return {
        kind: step.kind,
        scene: step.scene,
        multiple: step.multiple,
        regions: step.regions.map(({ id, label, shape }) => ({ id, label, shape })),
      };
    case 'grid':
      return { kind: step.kind, rows: step.rows, cols: step.cols, fixed: step.fixed };
    case 'manipulate':
    case 'explore':
      return { kind: step.kind, scene: step.scene, params: step.params };
    case 'drawing':
      return { kind: step.kind, ...(step.scene && { scene: step.scene }), aspect: step.aspect };
  }
}

const refuse = (message: string): ParsedResponse => ({ ok: false, message });
const accept = (value: unknown): ParsedResponse => ({ ok: true, value });
const sameKeys = (record: object, keys: readonly string[]) =>
  Object.keys(record).length === keys.length && keys.every((k) => Object.hasOwn(record, k));
const allDifferent = (values: readonly unknown[]) => new Set(values).size === values.length;
const cellKey = ([r, c]: readonly [number, number]) => `${r},${c}`;

/** Validates a response's shape against its step; refused responses are never recorded. */
export function parseInteractive(step: InteractiveStep, raw: unknown): ParsedResponse {
  const parsed = (interactiveResponse[step.kind] as z.ZodType).safeParse(raw);
  if (!parsed.success) return refuse(`This response does not fit a ${step.kind} step`);
  const value = parsed.data;
  const ids = (list: { id: string }[]) => list.map((o) => o.id);
  switch (step.kind) {
    case 'categorize': {
      const placed = value as Record<string, string>;
      const groups = ids(step.categories);
      return sameKeys(placed, ids(step.items)) &&
        Object.values(placed).every((c) => groups.includes(c))
        ? accept(placed)
        : refuse('Place every item in a group');
    }
    case 'fill_blanks': {
      const filled = value as Record<string, string>;
      if (!sameKeys(filled, gapsIn(step.text))) return refuse('Fill every gap');
      if (step.tiles) {
        const tiles = ids(step.tiles);
        if (!Object.values(filled).every((t) => tiles.includes(t))) return refuse('Unknown tile');
        if (!step.reuse && !allDifferent(Object.values(filled)))
          return refuse('Use each tile once');
      } else if (Object.values(filled).some((t) => t.trim() === ''))
        return refuse('Fill every gap');
      return accept(filled);
    }
    case 'label_diagram': {
      const filled = value as Record<string, string>;
      if (!sameKeys(filled, ids(step.targets))) return refuse('Place a label on every target');
      const labels = ids(step.labels);
      if (!Object.values(filled).every((l) => labels.includes(l))) return refuse('Unknown label');
      if (!step.reuse && !allDifferent(Object.values(filled))) return refuse('Use each label once');
      return accept(filled);
    }
    case 'plot_points': {
      const at = value as Record<string, XY>;
      if (!sameKeys(at, ids(step.points))) return refuse('Place every point');
      const [x0, x1] = step.scene.x;
      const [y0, y1] = step.scene.y;
      const fits = Object.values(at).every(
        ([x, y]) =>
          x >= x0 &&
          x <= x1 &&
          (step.line ? y === 0 : y >= y0 && y <= y1) &&
          onGrid(x, 0, step.snap) &&
          onGrid(y, 0, step.snap),
      );
      return fits ? accept(at) : refuse('A point is off the scene');
    }
    case 'sketch_graph': {
      const ys = value as number[];
      const [lo, hi] = step.scene.y;
      if (ys.length !== step.samples.count) return refuse('Draw the curve across the whole range');
      return ys.every((y) => y >= lo && y <= hi)
        ? accept(ys)
        : refuse('The curve leaves the scene');
    }
    case 'hotspot': {
      const picked = value as string[];
      const regions = ids(step.regions);
      if (!picked.every((p) => regions.includes(p)) || !allDifferent(picked)) {
        return refuse('Choose each region at most once');
      }
      if (picked.length === 0) return refuse('Choose a region first');
      if (!step.multiple && picked.length !== 1) return refuse('Choose one region');
      return accept(picked);
    }
    case 'grid': {
      const cells = value as XY[];
      const fixed = new Set(step.fixed.map(cellKey));
      const keys = cells.map(cellKey);
      const inside = cells.every(([r, c]) => r <= step.rows && c <= step.cols);
      if (!inside || !allDifferent(keys) || keys.some((k) => fixed.has(k))) {
        return refuse('Shade cells of the grid, each once');
      }
      return accept(cells);
    }
    case 'manipulate':
    case 'explore': {
      const values = value as Record<string, ParamValue>;
      const complete =
        step.kind === 'explore' ||
        sameKeys(
          values,
          step.params.map((p) => p.name),
        );
      const fits = Object.entries(values).every(([name, v]) => {
        const p = step.params.find((q) => q.name === name);
        return p !== undefined && paramAccepts(p, v);
      });
      return complete && fits ? accept(values) : refuse('A value is outside its control’s range');
    }
    case 'drawing': {
      const drawing = value as z.output<(typeof interactiveResponse)['drawing']>;
      return drawing.strokes.length > 0 || drawing.description.trim() !== ''
        ? accept(drawing)
        : refuse('Draw something or describe your drawing first');
    }
  }
}

/** Typed text as compared: outer and repeated spaces dropped, a typographic minus read as -. */
const normal = (text: string, caseSensitive: boolean) => {
  const plain = text.trim().replace(/\s+/g, ' ').replace(/−/g, '-');
  return caseSensitive ? plain : plain.toLowerCase();
};

/** Whether a typed or placed answer fills a fill-in gap. */
function fillsGap(step: FillBlanks, gapId: string, value: string): boolean {
  const gap = step.gaps.find((g) => g.id === gapId);
  if (!gap) return false;
  if (step.tiles) return gap.answer !== undefined && anyOf(gap.answer).includes(value);
  if (gap.number !== undefined) {
    const n = parseNumber(value);
    if (n !== null && Math.abs(n - gap.number) <= (gap.tolerance ?? 0)) return true;
  }
  const typed = normal(value, step.caseSensitive);
  return (gap.accept ?? []).some((a) => normal(a, step.caseSensitive) === typed);
}

/**
 * Judges a parsed response. `parts` marks each part right or wrong when the step marks parts;
 * a wrong answer's feedback is the first specific message that applies, else `incorrect`.
 */
export function judgeInteractive(step: InteractiveStep, value: unknown): Judgement {
  if (step.kind === 'explore') return { correct: true, feedback: step.feedback?.saved ?? '' };
  if (step.kind === 'drawing') return { correct: true, feedback: step.feedback.saved };
  if (step.kind === 'manipulate') {
    const scope = paramScope(step.params, value as Record<string, ParamValue>);
    if (step.target.every((t) => holds(t, scope))) {
      return { correct: true, feedback: step.feedback.correct };
    }
    const rule = step.feedback.rules.find((r) => holds(r.when, scope));
    return { correct: false, feedback: rule?.say ?? step.feedback.incorrect };
  }
  /** Right when every part is right and `complete` (nothing is missing); parts when marked. */
  const verdict = (parts: Record<string, boolean>, complete = true, specific?: string) => {
    const correct = complete && Object.values(parts).every(Boolean);
    const feedback = correct ? step.feedback.correct : (specific ?? step.feedback.incorrect);
    return { correct, feedback, ...(step.marks && { parts }) };
  };
  const each = <T extends { id: string }>(list: T[], right: (item: T) => boolean) =>
    Object.fromEntries(list.map((item) => [item.id, right(item)]));
  switch (step.kind) {
    case 'categorize': {
      const placed = value as Record<string, string>;
      const parts = each(step.items, (item) => placed[item.id] === item.category);
      const wrong = step.items.find((item) => !parts[item.id] && item.feedback);
      return verdict(parts, true, wrong?.feedback);
    }
    case 'fill_blanks': {
      const filled = value as Record<string, string>;
      return verdict(each(step.gaps, (gap) => fillsGap(step, gap.id, filled[gap.id] ?? '')));
    }
    case 'label_diagram': {
      const filled = value as Record<string, string>;
      return verdict(each(step.targets, (t) => anyOf(t.answer).includes(filled[t.id] ?? '')));
    }
    case 'plot_points': {
      const at = value as Record<string, XY>;
      const near = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= step.tolerance + 1e-9;
      const placed = (id: string): XY => at[id] ?? [Number.NaN, Number.NaN];
      if (!step.unordered) {
        return verdict(each(step.points, (p) => near(placed(p.id), pointAt(p.answer))));
      }
      const answers = step.points.map((p) => pointAt(p.answer));
      const reach = step.points.map((p) =>
        answers.flatMap((a, j) => (near(placed(p.id), a) ? [j] : [])),
      );
      const parts = Object.fromEntries(
        step.points.map((p, i) => [p.id, (reach[i] ?? []).length > 0]),
      );
      // Each point near some answer is not enough: two at one answer leave another unmet.
      return verdict(parts, perfectMatching(reach, answers.length) !== null);
    }
    case 'sketch_graph': {
      const ys = value as number[];
      const parts = Object.fromEntries(
        sampleXs(step).map((x, i) => [
          String(i),
          Math.abs((ys[i] ?? Number.NaN) - quantityValue(step.answer, { x })) <=
            step.tolerance + 1e-9,
        ]),
      );
      return verdict(parts);
    }
    case 'hotspot': {
      const picked = value as string[];
      const parts = Object.fromEntries(picked.map((id) => [id, step.correct.includes(id)]));
      const wrong = step.regions.find((r) => picked.includes(r.id) && !step.correct.includes(r.id));
      const complete = step.correct.every((id) => picked.includes(id));
      return verdict(parts, complete, wrong?.feedback);
    }
    case 'grid': {
      const cells = value as XY[];
      const shaded = step.fixed.length + cells.length;
      if ('count' in step.answer) {
        const correct = shaded === step.answer.count;
        return { correct, feedback: correct ? step.feedback.correct : step.feedback.incorrect };
      }
      const answer = new Set(step.answer.cells.map(cellKey));
      const parts = Object.fromEntries(cells.map((c) => [cellKey(c), answer.has(cellKey(c))]));
      return verdict(parts, shaded === answer.size);
    }
  }
}

/**
 * The answer Show solution moves into place, in the shape of a response; null for a kind with
 * no answer to show (a drawing, an exploration, a manipulation without `answer`).
 */
export function revealInteractive(step: InteractiveStep): unknown {
  switch (step.kind) {
    case 'categorize':
      return Object.fromEntries(step.items.map((i) => [i.id, i.category]));
    case 'fill_blanks': {
      const tiles = step.tiles?.map((t) => t.id) ?? [];
      // Interchangeable tiles are dealt so that no tile fills two gaps when reuse is off.
      const dealt =
        step.tiles && !step.reuse
          ? perfectMatching(
              step.gaps.map((g) => anyOf(g.answer ?? []).map((a) => tiles.indexOf(a))),
              tiles.length,
            )
          : null;
      return Object.fromEntries(
        step.gaps.map((g, i) => [
          g.id,
          dealt
            ? tiles[dealt[i] ?? -1]
            : g.answer !== undefined
              ? anyOf(g.answer)[0]
              : (g.accept?.[0] ?? String(g.number)),
        ]),
      );
    }
    case 'label_diagram': {
      const labels = step.labels.map((l) => l.id);
      const dealt = step.reuse
        ? null
        : perfectMatching(
            step.targets.map((t) => anyOf(t.answer).map((a) => labels.indexOf(a))),
            labels.length,
          );
      return Object.fromEntries(
        step.targets.map((t, i) => [t.id, dealt ? labels[dealt[i] ?? -1] : anyOf(t.answer)[0]]),
      );
    }
    case 'plot_points':
      // The reachable position nearest each answer, which lies within the tolerance of it.
      return Object.fromEntries(
        step.points.map((p) => {
          const [x, y] = pointAt(p.answer);
          const at: XY = [
            snapInside(x, step.snap, step.scene.x),
            step.line ? 0 : snapInside(y, step.snap, step.scene.y),
          ];
          return [p.id, at];
        }),
      );
    case 'sketch_graph':
      return sampleXs(step).map((x) => Number(quantityValue(step.answer, { x }).toFixed(6)));
    case 'hotspot':
      return step.correct;
    case 'grid': {
      const fixed = new Set(step.fixed.map(cellKey));
      if ('cells' in step.answer) return step.answer.cells.filter((c) => !fixed.has(cellKey(c)));
      const free: XY[] = [];
      for (let r = 1; r <= step.rows; r++) {
        for (let c = 1; c <= step.cols; c++) if (!fixed.has(cellKey([r, c]))) free.push([r, c]);
      }
      return free.slice(0, step.answer.count - step.fixed.length);
    }
    case 'manipulate':
      return step.answer ?? null;
    case 'explore':
    case 'drawing':
      return null;
  }
}
