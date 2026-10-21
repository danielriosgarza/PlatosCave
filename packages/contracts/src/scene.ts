import { z } from 'zod';
import {
  expressionProblem,
  MAX_EXPRESSION_LENGTH,
  placeholders,
  RESERVED_NAMES,
} from './expression';
import { iconName } from './icons';

/**
 * A scene: the diagram of an interactive exercise step (§9), written as data. Parallax draws it
 * as SVG in the step's own markup, so no author markup, script, style or address reaches the
 * page: a shape is one of the types below, its numbers may be expressions over the step's
 * parameters (`expression.ts`), and its look is chosen from the design tokens (ink, muted and
 * faint strokes; soft, muted and ink fills). Objects and figures come from the icon set
 * (`icons.ts`), named, never drawn from author markup. World coordinates have y pointing up.
 */

/** An expression's source text; which names it may read depends on where it stands. */
export const expressionText = z.string().trim().min(1).max(MAX_EXPRESSION_LENGTH);
/** A number, or an expression that gives one. */
export const quantity = z.union([z.number(), expressionText]);
export type Quantity = z.output<typeof quantity>;
const pair = z.tuple([quantity, quantity]);

/** A parameter's or counter's name: a letter, then letters, digits and `_`. */
export const paramName = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,19}$/,
    'must start with a letter and use only letters, digits and _ (at most 20)',
  )
  .refine((n) => !RESERVED_NAMES.has(n), {
    message: 'is a reserved name (a constant, a function, x or t)',
  });

/** A label drawn in the scene; `{expr}` and `{expr:2}` show a value. */
const sceneLabel = z.string().trim().min(1).max(200);

/** A range [low, high] of world coordinates. */
export const span = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo < hi, { message: 'the first value must be less than the second' });

const look = {
  /** Stroke: Ink (default), Muted or Faint (the rule colour). */
  tone: z.enum(['ink', 'muted', 'faint']).optional(),
  dash: z.boolean().optional(),
  weight: z.enum(['thin', 'normal', 'thick']).optional(),
  /** Drawn only while this condition holds. */
  show: expressionText.optional(),
  /** Draws the shape `count` times (at most 200), with `name` = 0, 1, … in its expressions. */
  each: z.object({ name: paramName, count: quantity }).optional(),
};
const fill = z.enum(['none', 'soft', 'muted', 'ink']).optional();

const point = z.object({
  type: z.literal('point'),
  at: pair,
  label: sceneLabel.optional(),
  size: z.enum(['small', 'normal', 'large']).optional(),
  ...look,
});
const segment = z.object({
  type: z.literal('segment'),
  from: pair,
  to: pair,
  arrow: z.enum(['none', 'end', 'both']).optional(),
  label: sceneLabel.optional(),
  ...look,
});
/** The whole line through two points, cut at the frame. */
const line = z.object({ type: z.literal('line'), through: z.tuple([pair, pair]), ...look });
const polygon = z.object({
  type: z.literal('polygon'),
  points: z.array(pair).min(2).max(50),
  /** false draws an open polyline. */
  closed: z.boolean().optional(),
  fill,
  ...look,
});
const circle = z.object({ type: z.literal('circle'), center: pair, r: quantity, fill, ...look });
/** A rectangle from its lower-left corner `at`, `size` wide and high. */
const rect = z.object({ type: z.literal('rect'), at: pair, size: pair, fill, ...look });
/** An arc from angle `from` to `to`, in degrees counter-clockwise from the x axis. */
const arc = z.object({
  type: z.literal('arc'),
  center: pair,
  r: quantity,
  from: quantity,
  to: quantity,
  /** Closes the arc to its centre, as a slice. */
  sector: z.boolean().optional(),
  fill,
  ...look,
});
/** The graph of y = f(x), with `x` bound, over `domain` or the frame's width. */
const graph = z.object({
  type: z.literal('function'),
  y: expressionText,
  domain: pair.optional(),
  ...look,
});
/** A parametric curve (x(t), y(t)) for t in `t`. */
const curve = z.object({
  type: z.literal('curve'),
  x: expressionText,
  y: expressionText,
  t: pair,
  ...look,
});
const text = z.object({
  type: z.literal('text'),
  at: pair,
  text: sceneLabel,
  align: z.enum(['start', 'middle', 'end']).optional(),
  size: z.enum(['small', 'normal', 'large']).optional(),
  ...look,
});
/**
 * An icon (`icons.ts`) centred on `at`, `size` x units across (1 by default) and turned `rotate`
 * degrees counter-clockwise; `label` is written under it.
 */
const icon = z.object({
  type: z.literal('icon'),
  name: iconName,
  at: pair,
  size: z.union([z.number().positive(), expressionText]).optional(),
  rotate: quantity.optional(),
  fill,
  label: sceneLabel.optional(),
  ...look,
});

export const sceneShape = z.discriminatedUnion('type', [
  point,
  segment,
  line,
  polygon,
  circle,
  rect,
  arc,
  graph,
  curve,
  text,
  icon,
]);
export type SceneShape = z.output<typeof sceneShape>;

export const scene = z.object({
  x: span,
  y: span,
  /** Width over height. By default units are equal on both axes, kept between 1:2 and 2.5:1. */
  aspect: z.number().min(0.4).max(4).optional(),
  /** Draws the axes through 0, with names when given. */
  axes: z
    .union([z.boolean(), z.object({ x: sceneLabel.optional(), y: sceneLabel.optional() })])
    .optional(),
  /** Grid lines every `grid` units, or at the tick spacing for `true`. */
  grid: z.union([z.boolean(), z.number().positive()]).optional(),
  /** Spacing of the numbered ticks on the axes; chosen from the range when absent. */
  ticks: z.number().positive().optional(),
  /** What the scene shows, for a screen reader. */
  description: z.string().trim().min(1).max(1000).optional(),
  shapes: z.array(sceneShape).max(60).default([]),
});
export type Scene = z.output<typeof scene>;

/** A "nice" spacing (1, 2 or 5 × 10ⁿ) giving about `target` intervals across `span`. */
export function niceStep(span: number, target = 8): number {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

/** The shapes' repeats are capped: a scene draws at most this many copies of one shape. */
export const MAX_REPEAT = 200;

export type FieldProblem = { path: (string | number)[]; message: string };

const quantities = (value: unknown): value is string => typeof value === 'string';

/**
 * Every expression of `scene` checked against `names` (the step's parameters), with the names
 * each shape binds added; empty when every expression parses and reads only defined names.
 */
export function sceneProblems(scene: Scene, names: readonly string[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const check = (path: (string | number)[], source: string, extra: string[] = []) => {
    const problem = expressionProblem(source, [...names, ...extra]);
    if (problem) problems.push({ path, message: problem });
  };
  const label = (path: (string | number)[], text: string, extra: string[]) => {
    for (const { source } of placeholders(text)) check(path, source, extra);
  };
  scene.shapes.forEach((shape, i) => {
    const at = (...rest: (string | number)[]) => ['scene', 'shapes', i, ...rest];
    const counter = shape.each ? [shape.each.name] : [];
    if (shape.each) {
      if (names.includes(shape.each.name)) {
        problems.push({
          path: at('each', 'name'),
          message: `${shape.each.name} is already a parameter`,
        });
      }
      if (quantities(shape.each.count)) check(at('each', 'count'), shape.each.count);
    }
    if (shape.show) check(at('show'), shape.show, counter);
    const visit = (value: unknown, path: (string | number)[], extra: string[]) => {
      if (quantities(value)) check(path, value, extra);
      else if (Array.isArray(value))
        for (const [j, v] of value.entries()) visit(v, [...path, j], extra);
    };
    for (const [key, value] of Object.entries(shape)) {
      // An icon's size is a number or an expression; a point's or a text's is a word.
      if (key === 'size' && shape.type === 'icon') {
        visit(value, at(key), counter);
        continue;
      }
      if (
        [
          'type',
          'name',
          'tone',
          'dash',
          'weight',
          'show',
          'each',
          'fill',
          'arrow',
          'size',
          'align',
          'closed',
          'sector',
        ].includes(key)
      )
        continue;
      if (key === 'label' || key === 'text') {
        label(at(key), value as string, counter);
        continue;
      }
      const bound =
        shape.type === 'function' && key === 'y'
          ? ['x']
          : shape.type === 'curve' && (key === 'x' || key === 'y')
            ? ['t']
            : [];
      visit(value, at(key), [...counter, ...bound]);
    }
  });
  return problems;
}
