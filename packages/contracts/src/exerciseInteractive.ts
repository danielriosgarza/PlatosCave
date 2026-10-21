import { z } from 'zod';
import { strokes } from './anchors';
import { common, feedback, label, option, prose, stepId } from './exerciseBase';
import { expressionProblem, holds, quantityValue } from './expression';
import {
  expressionText,
  type FieldProblem,
  paramName,
  type Scene,
  scene,
  sceneProblems,
  span,
} from './scene';

/**
 * The interactive kinds of `exercise.v1` step (§9, amended 21 October 2026): steps a learner
 * answers by dragging, drawing and manipulating a scene rather than by typing or choosing.
 * Like every step they have a prompt, hints, a solution and feedback, their answer key stays on
 * the server, and each pointer gesture has a keyboard equivalent in the student view. A step
 * that marks parts (`marks: true`) tells the learner which parts of a wrong answer are right.
 */

/** Whether a check tells the learner which parts are right; off by default, like brute force. */
const marks = z.boolean().default(false);
const shuffle = z.boolean().default(true);
export const xy = z.tuple([z.number(), z.number()]);
/** One answer, or any of several. */
const oneOf = z.union([stepId, z.array(stepId).min(1).max(20)]);

/** Drag items into groups. */
export const categorizeStep = z.object({
  ...common,
  kind: z.literal('categorize'),
  categories: z.array(option).min(2).max(6),
  /** Each item names the category it belongs in; `feedback` is shown when it is misplaced. */
  items: z
    .array(option.extend({ category: stepId, feedback: prose.optional() }))
    .min(2)
    .max(20),
  shuffle,
  marks,
  feedback,
});

/** Fill the `[[id]]` gaps of a sentence or formula with tiles, or by typing. */
export const fillBlanksStep = z.object({
  ...common,
  kind: z.literal('fill_blanks'),
  text: z.string().trim().min(1).max(2000),
  gaps: z
    .array(
      z.object({
        id: stepId,
        /** With tiles: the tile, or any of the tiles, that fills the gap. */
        answer: oneOf.optional(),
        /** Typed: answers accepted without regard to case or spacing. */
        accept: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
        /** Typed: a number accepted within `tolerance`. */
        number: z.number().optional(),
        tolerance: z.number().min(0).optional(),
      }),
    )
    .min(1)
    .max(20),
  /** The tiles to drag, distractors included. Without tiles every gap is typed. */
  tiles: z.array(option).min(1).max(24).optional(),
  /** A tile may fill more than one gap. */
  reuse: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  shuffle,
  marks,
  feedback,
});

/** Drag labels onto places of a diagram. */
export const labelDiagramStep = z.object({
  ...common,
  kind: z.literal('label_diagram'),
  scene,
  targets: z
    .array(z.object({ id: stepId, at: xy, answer: oneOf }))
    .min(1)
    .max(12),
  /** The labels to drag, distractors included. */
  labels: z.array(option).min(2).max(20),
  reuse: z.boolean().default(false),
  shuffle,
  marks,
  feedback,
});

/** Drag points onto a plane, or onto a number line with `line: true`. */
export const plotPointsStep = z.object({
  ...common,
  kind: z.literal('plot_points'),
  scene,
  /** A number line: points move along the x axis, and positions are single numbers. */
  line: z.boolean().default(false),
  points: z
    .array(
      z.object({
        id: stepId,
        label: z.string().trim().min(1).max(40),
        /** Placed at the start; without it the point waits beside the scene. */
        start: z.union([z.number(), xy]).optional(),
        answer: z.union([z.number(), xy]),
      }),
    )
    .min(1)
    .max(8),
  /** Points move in steps of `snap`: each coordinate is a whole multiple of it. */
  snap: z.number().positive(),
  /** The distance from an answer that is still accepted. */
  tolerance: z.number().min(0).default(0),
  /** The points are interchangeable: any point may stand at any answer. */
  unordered: z.boolean().default(false),
  marks,
  feedback,
});

/** Draw the graph of a function; it is read at `samples` and compared within `tolerance`. */
export const sketchGraphStep = z.object({
  ...common,
  kind: z.literal('sketch_graph'),
  scene,
  /** The curve to draw, as y in terms of x. */
  answer: expressionText,
  samples: z.object({ from: z.number(), to: z.number(), count: z.int().min(2).max(41) }),
  tolerance: z.number().positive(),
  /** The height the curve starts at; 0, or the middle of the y range when 0 is outside it. */
  start: z.number().optional(),
  marks,
  feedback,
});

export const regionShape = z.discriminatedUnion('type', [
  z.object({ type: z.literal('circle'), center: xy, r: z.number().positive() }),
  z.object({
    type: z.literal('rect'),
    at: xy,
    size: z.tuple([z.number().positive(), z.number().positive()]),
  }),
  z.object({ type: z.literal('polygon'), points: z.array(xy).min(3).max(50) }),
]);

/** Choose regions of a diagram. */
export const hotspotStep = z.object({
  ...common,
  kind: z.literal('hotspot'),
  scene,
  regions: z
    .array(
      z.object({
        id: stepId,
        /** The region's name for a screen reader, and on its keyboard control. */
        label,
        shape: regionShape,
        /** Shown when the region is chosen wrongly. */
        feedback: prose.optional(),
      }),
    )
    .min(2)
    .max(24),
  correct: z.array(stepId).min(1),
  /** Several regions may be chosen; otherwise exactly one. */
  multiple: z.boolean().default(false),
  marks,
  feedback,
});

/** A cell [row, column], counted from 1. */
export const cell = z.tuple([z.int().min(1).max(12), z.int().min(1).max(12)]);

/** Shade cells of a grid: a given pattern, or any `count` cells. */
export const gridStep = z.object({
  ...common,
  kind: z.literal('grid'),
  rows: z.int().min(1).max(12),
  cols: z.int().min(1).max(12),
  /** Shaded from the start and locked. */
  fixed: z.array(cell).max(144).default([]),
  /** The shaded cells, fixed ones included: exactly `cells`, or any `count` of them. */
  answer: z.union([
    z.object({ cells: z.array(cell).max(144) }).strict(),
    z.object({ count: z.int().min(0).max(144) }).strict(),
  ]),
  marks,
  feedback,
});

export const sliderParam = z.object({
  kind: z.literal('slider').optional(),
  name: paramName,
  label,
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  initial: z.number(),
  unit: z.string().trim().max(20).optional(),
  /** A Play button runs the value from `min` to `max` in `seconds`. */
  animate: z
    .object({ seconds: z.number().min(0.5).max(120), loop: z.boolean().default(true) })
    .optional(),
});
/** A handle dragged in the scene; expressions read it as `P.x` and `P.y`. */
export const pointParam = z.object({
  kind: z.literal('point'),
  name: paramName,
  label,
  x: span,
  y: span,
  step: z.number().positive(),
  initial: xy,
});
export const param = z.union([pointParam, sliderParam]);
export type Param = z.output<typeof param>;
/** A parameter's value: a number, or [x, y] for a point. */
export const paramValue = z.union([z.number(), xy]);
export type ParamValue = z.output<typeof paramValue>;

/** Move sliders and handles until every condition of `target` holds. */
export const manipulateStep = z.object({
  ...common,
  kind: z.literal('manipulate'),
  params: z.array(param).min(1).max(8),
  scene,
  target: z.array(expressionText).min(1).max(10),
  /** Values that meet the target, moved into place by Show solution. */
  answer: z.record(z.string(), paramValue).optional(),
  feedback: feedback.extend({
    /** The first rule whose condition holds gives the feedback on a wrong answer. */
    rules: z
      .array(z.object({ when: expressionText, say: prose }))
      .max(10)
      .default([]),
  }),
});

/** A scene to watch and play with; Continue completes it. */
export const exploreStep = z.object({
  ...common,
  kind: z.literal('explore'),
  params: z.array(param).max(8).default([]),
  scene,
  feedback: z.object({ saved: prose }).optional(),
});

/** A freehand drawing saved for the instructor, with a description; nothing grades it. */
export const drawingStep = z.object({
  ...common,
  kind: z.literal('drawing'),
  /** What the learner draws on; a blank sheet when absent. */
  scene: scene.optional(),
  /** Width over height of a blank sheet. */
  aspect: z.number().min(0.4).max(4).default(1.6),
  feedback: z.object({ saved: prose }),
});

export const interactiveSteps = [
  categorizeStep,
  fillBlanksStep,
  labelDiagramStep,
  plotPointsStep,
  sketchGraphStep,
  hotspotStep,
  gridStep,
  manipulateStep,
  exploreStep,
  drawingStep,
] as const;

export const interactiveKinds = [
  'categorize',
  'fill_blanks',
  'label_diagram',
  'plot_points',
  'sketch_graph',
  'hotspot',
  'grid',
  'manipulate',
  'explore',
  'drawing',
] as const;
export type InteractiveKind = (typeof interactiveKinds)[number];
export const isInteractiveKind = (kind: string): kind is InteractiveKind =>
  (interactiveKinds as readonly string[]).includes(kind);

export type InteractiveStep = z.output<(typeof interactiveSteps)[number]>;
export type CategorizeStep = z.output<typeof categorizeStep>;
export type FillBlanksStep = z.output<typeof fillBlanksStep>;
export type LabelDiagramStep = z.output<typeof labelDiagramStep>;
export type PlotPointsStep = z.output<typeof plotPointsStep>;
export type SketchGraphStep = z.output<typeof sketchGraphStep>;
export type HotspotStep = z.output<typeof hotspotStep>;
export type GridStep = z.output<typeof gridStep>;
export type ManipulateStep = z.output<typeof manipulateStep>;

/** A freehand drawing as a drawing step saves it: at most 20 000 points in all. */
export const MAX_DRAWING_POINTS = 20_000;
export const drawingResponse = z.object({
  strokes: strokes.refine(
    (list) => list.reduce((n, s) => n + s.points.length, 0) <= MAX_DRAWING_POINTS,
    { message: `a drawing holds at most ${MAX_DRAWING_POINTS} points` },
  ),
  description: z.string().max(4000).default(''),
});

/** Responses of the interactive kinds; the server parses a check against its step's kind. */
export const interactiveResponse = {
  categorize: z.record(stepId, stepId),
  fill_blanks: z.record(stepId, z.string().max(200)),
  label_diagram: z.record(stepId, stepId),
  plot_points: z.record(stepId, xy),
  sketch_graph: z.array(z.number()).max(41),
  hotspot: z.array(stepId).max(24),
  grid: z.array(cell).max(144),
  manipulate: z.record(z.string().max(20), paramValue),
  explore: z.record(z.string().max(20), paramValue).default({}),
  drawing: drawingResponse,
} as const satisfies Record<InteractiveKind, z.ZodType>;

/** The names a parameter list gives expressions: `a` for a slider, `P.x` and `P.y` for a point. */
export function paramNames(params: readonly Param[]): string[] {
  return params.flatMap((p) => (p.kind === 'point' ? [`${p.name}.x`, `${p.name}.y`] : [p.name]));
}

/** The expression scope of parameter values, by the names of `paramNames`. */
export function paramScope(
  params: readonly Param[],
  values: Readonly<Record<string, ParamValue>>,
): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const p of params) {
    const v = Object.hasOwn(values, p.name) ? values[p.name] : undefined;
    if (p.kind === 'point') {
      const [x, y] = Array.isArray(v) ? v : p.initial;
      scope[`${p.name}.x`] = x;
      scope[`${p.name}.y`] = y;
    } else scope[p.name] = typeof v === 'number' ? v : p.initial;
  }
  return scope;
}

/** A value snapped to six decimals, as every control and handle sends it. */
export const snapped = (v: number) => Number(v.toFixed(6));

/** Whether `v` is a whole multiple of `size` from `origin`, as a control or handle sends it. */
export function onGrid(v: number, origin: number, size: number): boolean {
  const k = Math.round((v - origin) / size);
  return Number.isFinite(k) && v === snapped(origin + k * size);
}

/** The nearest point of the grid of multiples of `size` from `origin`, snapped as sent. */
export const toGrid = (v: number, origin: number, size: number) =>
  snapped(origin + Math.round((v - origin) / size) * size);

/** The multiple of `snap` nearest to `v` that lies in [lo, hi]: where a plotted point can stand. */
export function snapInside(v: number, snap: number, [lo, hi]: readonly [number, number]): number {
  const first = Math.ceil(lo / snap - 1e-9);
  const last = Math.floor(hi / snap + 1e-9);
  const k = Math.min(last, Math.max(first, Math.round(v / snap)));
  return toGrid(k * snap, 0, snap);
}

/** The values a parameter's control offers: on its grid and in its range. */
export function paramAccepts(p: Param, v: unknown): boolean {
  if (p.kind === 'point') {
    if (!Array.isArray(v) || v.length !== 2) return false;
    const [x, y] = v as [number, number];
    return (
      x >= p.x[0] &&
      x <= p.x[1] &&
      y >= p.y[0] &&
      y <= p.y[1] &&
      onGrid(x, p.x[0], p.step) &&
      onGrid(y, p.y[0], p.step)
    );
  }
  return typeof v === 'number' && v >= p.min && v <= p.max && onGrid(v, p.min, p.step);
}

/**
 * Whether every left node can be paired with a distinct right node it accepts: Kuhn's
 * augmenting paths, enough for the dozens of nodes a step has. Returns the pairing or null.
 */
export function perfectMatching(
  accepts: readonly (readonly number[])[],
  rights: number,
): number[] | null {
  const owner = new Array<number>(rights).fill(-1);
  const tryAssign = (left: number, seen: boolean[]): boolean => {
    for (const r of accepts[left] ?? []) {
      if (seen[r]) continue;
      seen[r] = true;
      if (owner[r] === -1 || tryAssign(owner[r] as number, seen)) {
        owner[r] = left;
        return true;
      }
    }
    return false;
  };
  for (let left = 0; left < accepts.length; left++) {
    if (!tryAssign(left, new Array<boolean>(rights).fill(false))) return null;
  }
  const pairing = new Array<number>(accepts.length).fill(-1);
  owner.forEach((left, r) => {
    if (left !== -1) pairing[left] = r;
  });
  return pairing;
}

/** The gap ids of a fill-in text, in order of appearance. */
export const gapsIn = (text: string) =>
  [...text.matchAll(/\[\[([^\]]*)\]\]/g)].map((m) => m[1] as string);

const ids = (list: readonly { id: string }[]) => list.map((o) => o.id);
const duplicates = (list: readonly string[]) => list.filter((x, i) => list.indexOf(x) !== i);
const answers = (a: string | string[]) => (Array.isArray(a) ? a : [a]);

/** The frame a value must lie in: inside both ranges of the scene. */
const inScene = (s: Scene, [x, y]: readonly [number, number]) =>
  x >= s.x[0] && x <= s.x[1] && y >= s.y[0] && y <= s.y[1];

/** Whether answers drawn from `options` can fill `slots` without using one twice. */
function fillable(slots: readonly (string | string[])[], options: readonly string[]) {
  return perfectMatching(
    slots.map((a) => answers(a).map((id) => options.indexOf(id))),
    options.length,
  );
}

/** Cross-field rules of an interactive step, each with the path of the field it concerns. */
export function interactiveProblems(step: InteractiveStep): FieldProblem[] {
  const out: FieldProblem[] = [];
  const add = (path: (string | number)[], message: string) => out.push({ path, message });
  const unique = (path: string, list: readonly { id: string }[]) => {
    const twice = duplicates(ids(list));
    if (twice.length) add([path], `ids must be unique (${[...new Set(twice)].join(', ')} repeats)`);
  };
  switch (step.kind) {
    case 'categorize': {
      unique('categories', step.categories);
      unique('items', step.items);
      step.items.forEach((item, i) => {
        if (!ids(step.categories).includes(item.category)) {
          add(['items', i, 'category'], `names no category (${item.category})`);
        }
      });
      break;
    }
    case 'fill_blanks': {
      unique('gaps', step.gaps);
      const inText = gapsIn(step.text);
      const twice = duplicates(inText);
      if (twice.length) add(['text'], `a gap may stand once in the text ([[${twice[0]}]] repeats)`);
      for (const id of inText) {
        if (!ids(step.gaps).includes(id)) add(['text'], `[[${id}]] names no gap`);
      }
      step.gaps.forEach((gap, i) => {
        if (!inText.includes(gap.id))
          add(['gaps', i], `gap ${gap.id} is not in the text as [[${gap.id}]]`);
      });
      if (step.tiles) {
        unique('tiles', step.tiles);
        step.gaps.forEach((gap, i) => {
          if (gap.answer === undefined)
            add(['gaps', i, 'answer'], 'with tiles, every gap needs the tile that answers it');
          else if (!answers(gap.answer).every((a) => ids(step.tiles ?? []).includes(a))) {
            add(['gaps', i, 'answer'], 'names no tile');
          }
          if (gap.accept || gap.number !== undefined) {
            add(['gaps', i], 'with tiles, a gap takes a tile: remove accept and number');
          }
        });
        const complete = step.gaps.every((g) => g.answer !== undefined);
        if (
          complete &&
          !step.reuse &&
          !fillable(
            step.gaps.map((g) => g.answer ?? []),
            ids(step.tiles),
          )
        ) {
          add(['gaps'], 'two gaps need the same tile: add another tile or set reuse: true');
        }
      } else {
        step.gaps.forEach((gap, i) => {
          if (gap.answer !== undefined)
            add(['gaps', i, 'answer'], 'there are no tiles: use accept or number');
          if (!gap.accept && gap.number === undefined) {
            add(['gaps', i], 'a typed gap needs accept (the answers taken) or number');
          }
          if (gap.tolerance !== undefined && gap.number === undefined) {
            add(['gaps', i, 'tolerance'], 'tolerance applies to number');
          }
        });
      }
      break;
    }
    case 'label_diagram': {
      out.push(...sceneProblems(step.scene, []));
      unique('targets', step.targets);
      unique('labels', step.labels);
      step.targets.forEach((target, i) => {
        if (!answers(target.answer).every((a) => ids(step.labels).includes(a))) {
          add(['targets', i, 'answer'], 'names no label');
        }
        if (!inScene(step.scene, target.at)) add(['targets', i, 'at'], 'lies outside the scene');
      });
      if (
        out.length === 0 &&
        !step.reuse &&
        !fillable(
          step.targets.map((t) => t.answer),
          ids(step.labels),
        )
      ) {
        add(['targets'], 'two targets need the same label: add another label or set reuse: true');
      }
      break;
    }
    case 'plot_points': {
      out.push(...sceneProblems(step.scene, []));
      unique('points', step.points);
      const [lo, hi] = step.scene.x;
      const steps = (hi - lo) / step.snap;
      if (steps > 2000) add(['snap'], 'gives more than 2000 positions across the scene');
      const position = (v: number | [number, number]): [number, number] | null => {
        if (step.line) return typeof v === 'number' ? [v, 0] : null;
        return Array.isArray(v) ? v : null;
      };
      const shape = step.line ? 'a number on a number line' : '[x, y]';
      step.points.forEach((point, i) => {
        for (const key of ['start', 'answer'] as const) {
          const value = point[key];
          if (value === undefined) continue;
          const at = position(value);
          if (!at) {
            add(['points', i, key], `must be ${shape}`);
            continue;
          }
          if (step.line ? at[0] < lo || at[0] > hi : !inScene(step.scene, at)) {
            add(['points', i, key], 'lies outside the scene');
            continue;
          }
          const nearest = at.map((c) => toGrid(c, 0, step.snap));
          const onSnap = at.every((c) => onGrid(c, 0, step.snap));
          if (key === 'start' && !onSnap)
            add(['points', i, key], `must be a multiple of snap (${step.snap})`);
          const miss = Math.hypot((nearest[0] ?? 0) - at[0], (nearest[1] ?? 0) - at[1]);
          if (key === 'answer' && miss > step.tolerance + 1e-9) {
            add(
              ['points', i, key],
              'no position a point can reach is within tolerance of it: use a multiple of snap or a larger tolerance',
            );
          }
        }
      });
      break;
    }
    case 'sketch_graph': {
      out.push(...sceneProblems(step.scene, []));
      const problem = expressionProblem(step.answer, ['x']);
      if (problem) add(['answer'], problem);
      const { from, to } = step.samples;
      if (from >= to) add(['samples'], 'from must be less than to');
      else if (from < step.scene.x[0] || to > step.scene.x[1])
        add(['samples'], 'must lie inside the scene');
      if (
        step.start !== undefined &&
        (step.start < step.scene.y[0] || step.start > step.scene.y[1])
      ) {
        add(['start'], 'lies outside the scene');
      }
      if (!problem && from < to) {
        const outside = sampleXs(step).find((x) => {
          const y = quantityValue(step.answer, { x });
          return !Number.isFinite(y) || y < step.scene.y[0] || y > step.scene.y[1];
        });
        if (outside !== undefined)
          add(['answer'], `leaves the scene at x = ${outside}, so it cannot be drawn there`);
      }
      break;
    }
    case 'hotspot': {
      out.push(...sceneProblems(step.scene, []));
      unique('regions', step.regions);
      step.correct.forEach((c, i) => {
        if (!ids(step.regions).includes(c)) add(['correct', i], `names no region (${c})`);
      });
      if (duplicates(step.correct).length) add(['correct'], 'names a region twice');
      if (!step.multiple && step.correct.length !== 1) {
        add(['correct'], 'names one region, or set multiple: true');
      }
      break;
    }
    case 'grid': {
      const key = ([r, c]: [number, number]) => `${r},${c}`;
      const check = (path: string[], cells: [number, number][]) => {
        cells.forEach(([r, c], i) => {
          if (r > step.rows || c > step.cols)
            add([...path, i], `lies outside the ${step.rows} × ${step.cols} grid`);
        });
        if (duplicates(cells.map(key)).length) add(path, 'names a cell twice');
      };
      check(['fixed'], step.fixed);
      if ('cells' in step.answer) {
        const answer = step.answer.cells.map(key);
        check(['answer', 'cells'], step.answer.cells);
        if (!step.fixed.every((f) => answer.includes(key(f)))) {
          add(['answer', 'cells'], 'must include the fixed cells, which stay shaded');
        }
      } else if (
        step.answer.count < step.fixed.length ||
        step.answer.count > step.rows * step.cols
      ) {
        add(
          ['answer', 'count'],
          `must be between the fixed cells (${step.fixed.length}) and all cells (${step.rows * step.cols})`,
        );
      }
      break;
    }
    case 'manipulate':
    case 'explore': {
      out.push(...paramProblems(step.params));
      const names = paramNames(step.params);
      out.push(...sceneProblems(step.scene, names));
      if (step.kind === 'explore') break;
      step.target.forEach((t, i) => {
        const problem = expressionProblem(t, names);
        if (problem) add(['target', i], problem);
      });
      step.feedback.rules.forEach((rule, i) => {
        const problem = expressionProblem(rule.when, names);
        if (problem) add(['feedback', 'rules', i, 'when'], problem);
      });
      if (step.answer && out.length === 0) {
        const answer = step.answer;
        for (const name of Object.keys(answer)) {
          if (!step.params.some((p) => p.name === name))
            add(['answer', name], 'names no parameter');
        }
        step.params.forEach((p) => {
          if (!Object.hasOwn(answer, p.name)) add(['answer'], `gives no value for ${p.name}`);
          else if (!paramAccepts(p, answer[p.name])) {
            add(['answer', p.name], 'is not a value the control offers (in range, min + k·step)');
          }
        });
        if (out.length === 0) {
          const scope = paramScope(step.params, answer);
          const missed = step.target.findIndex((t) => !holds(t, scope));
          if (missed !== -1) add(['answer'], `does not meet the target ${step.target[missed]}`);
        }
      }
      break;
    }
    case 'drawing':
      if (step.scene) out.push(...sceneProblems(step.scene, []));
      break;
  }
  return out;
}

function paramProblems(params: readonly Param[]): FieldProblem[] {
  const out: FieldProblem[] = [];
  const twice = duplicates(params.map((p) => p.name));
  if (twice.length)
    out.push({ path: ['params'], message: `names must be unique (${twice[0]} repeats)` });
  params.forEach((p, i) => {
    const add = (key: string, message: string) => out.push({ path: ['params', i, key], message });
    if (p.kind === 'point') {
      if (!paramAccepts(p, p.initial))
        add('initial', 'must lie in the ranges, on the grid of step from the low ends');
      for (const axis of ['x', 'y'] as const) {
        if ((p[axis][1] - p[axis][0]) / p.step > 2000) add(axis, 'gives more than 2000 positions');
      }
      return;
    }
    if (p.min >= p.max) add('max', 'must be greater than min');
    else if (!paramAccepts(p, p.initial))
      add('initial', 'must be a value the control offers (in range, min + k·step)');
    else if ((p.max - p.min) / p.step > 10_000) add('step', 'gives more than 10 000 values');
  });
  return out;
}

/** The x values a sketch is read at: `count` evenly spaced from `from` to `to`, six decimals. */
export function sampleXs(step: { samples: { from: number; to: number; count: number } }): number[] {
  const { from, to, count } = step.samples;
  return Array.from({ length: count }, (_, i) => snapped(from + ((to - from) * i) / (count - 1)));
}

const shown = z.array(z.object({ id: z.string(), label: z.string() }));

/**
 * What a student sees of an interactive step's own fields: the scene and the pieces to move,
 * in the order the attempt's seed drew, and no answer, feedback, tolerance or target.
 */
export const interactiveView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('categorize'), categories: shown, items: shown }),
  z.object({
    kind: z.literal('fill_blanks'),
    text: z.string(),
    gaps: z.array(z.string()),
    /** Absent when the gaps are typed. */
    tiles: shown.optional(),
    reuse: z.boolean(),
  }),
  z.object({
    kind: z.literal('label_diagram'),
    scene,
    targets: z.array(z.object({ id: z.string(), at: xy })),
    labels: shown,
    reuse: z.boolean(),
  }),
  z.object({
    kind: z.literal('plot_points'),
    scene,
    line: z.boolean(),
    snap: z.number(),
    points: z.array(z.object({ id: z.string(), label: z.string(), start: xy.optional() })),
  }),
  z.object({
    kind: z.literal('sketch_graph'),
    scene,
    xs: z.array(z.number()),
    start: z.number(),
  }),
  z.object({
    kind: z.literal('hotspot'),
    scene,
    multiple: z.boolean(),
    regions: z.array(z.object({ id: z.string(), label: z.string(), shape: regionShape })),
  }),
  z.object({ kind: z.literal('grid'), rows: z.int(), cols: z.int(), fixed: z.array(cell) }),
  z.object({ kind: z.literal('manipulate'), scene, params: z.array(param) }),
  z.object({ kind: z.literal('explore'), scene, params: z.array(param) }),
  z.object({ kind: z.literal('drawing'), scene: scene.optional(), aspect: z.number() }),
]);
export type InteractiveView = z.output<typeof interactiveView>;
