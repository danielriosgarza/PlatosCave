import { type ExerciseStep, exerciseResponse, type exerciseStepView } from '@parallax/contracts';
import type { z } from 'zod';

/**
 * Server-side rules of `exercise.v1` steps (§9): parsing a response against its step,
 * judging it with targeted feedback, and the seeded order a student sees. Pure functions;
 * answer keys never leave this module except as feedback text.
 */

export type StepView = z.input<typeof exerciseStepView>;
export type Judgement = { correct: boolean; feedback: string };
export type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

/** mulberry32: a small deterministic PRNG, so a seed always replays the same order. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a generator seeded by the attempt seed and the step id. */
export function seededShuffle<T>(list: readonly T[], seed: number, stepId: string): T[] {
  let salt = seed;
  for (const ch of stepId) salt = Math.imul(salt ^ ch.charCodeAt(0), 0x01000193);
  const next = random(salt);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const labelled = (list: { id: string; label: string }[]) =>
  list.map(({ id, label }) => ({ id, label }));

/** The step as a student sees it in an attempt with `seed`: no key, feedback or solution. */
export function viewStep(step: ExerciseStep, seed: number): StepView {
  const order = <T>(list: T[], shuffle: boolean) =>
    shuffle ? seededShuffle(list, seed, step.id) : list;
  const base = {
    id: step.id,
    kind: step.kind,
    title: step.title,
    prompt: step.prompt,
    hintCount: step.hints.length,
    hasSolution: step.solution !== undefined,
  };
  switch (step.kind) {
    case 'numeric':
      return { ...base, ...(step.unit !== undefined && { unit: step.unit }) };
    case 'single_choice':
    case 'multiple_choice':
      return { ...base, options: labelled(order(step.options, step.shuffle)) };
    case 'ordering':
      return { ...base, options: labelled(order(step.items, step.shuffle)) };
    case 'matching':
      return {
        ...base,
        prompts: labelled(step.prompts),
        choices: labelled(order(step.choices, step.shuffle)),
      };
    case 'simulation':
      return {
        ...base,
        control: step.control,
        observations: step.observations.map(({ id, label, unit }) => ({ id, label, unit })),
        compare: step.compare,
      };
    case 'text':
      return { ...base, maxLength: step.maxLength };
    case 'code':
      return { ...base, language: step.language, starter: step.starter };
  }
}

const refuse = (message: string): Parsed => ({ ok: false, message });

/** Validates a response's shape against its step; refused responses are never recorded. */
export function parseResponse(step: ExerciseStep, raw: unknown): Parsed {
  const parsed = exerciseResponse[step.kind].safeParse(raw);
  if (!parsed.success) return refuse(`This response does not fit a ${step.kind} step`);
  const value = parsed.data;
  const known = (list: { id: string }[], picked: string[]) =>
    picked.every((id) => list.some((o) => o.id === id));
  switch (step.kind) {
    case 'single_choice':
      return known(step.options, [value as string])
        ? { ok: true, value }
        : refuse('Unknown option');
    case 'multiple_choice': {
      const picked = value as string[];
      if (!known(step.options, picked) || new Set(picked).size !== picked.length) {
        return refuse('Choose each option at most once');
      }
      return { ok: true, value };
    }
    case 'ordering': {
      const order = value as string[];
      const complete = order.length === step.items.length && new Set(order).size === order.length;
      return complete && known(step.items, order)
        ? { ok: true, value }
        : refuse('Place every item exactly once');
    }
    case 'matching': {
      const pairs = value as Record<string, string>;
      const keys = Object.keys(pairs);
      const complete = keys.length === step.prompts.length && known(step.prompts, keys);
      return complete && known(step.choices, Object.values(pairs))
        ? { ok: true, value }
        : refuse('Match every prompt to one of the choices');
    }
    case 'simulation': {
      const { value: v, observations } = value as { value: number; observations: object };
      const { min, max, step: size } = step.control;
      const onGrid = Math.abs((v - min) / size - Math.round((v - min) / size)) < 1e-9;
      if (v < min || v > max || !onGrid) return refuse(`${step.control.label} is out of range`);
      return known(step.observations, Object.keys(observations))
        ? { ok: true, value }
        : refuse('Only the declared observations are recorded');
    }
    case 'text':
    case 'code': {
      const text = value as string;
      if (step.kind === 'text' && text.trim() === '') return refuse('Write your explanation first');
      if (step.kind === 'text' && text.length > step.maxLength) return refuse('Too long');
      return { ok: true, value };
    }
    default:
      return { ok: true, value };
  }
}

/**
 * Judges a parsed response. `compared` holds simulation values checked earlier in the
 * attempt; a simulation step is correct once every `compare` value has been checked.
 */
export function judge(step: ExerciseStep, value: unknown, compared: number[] = []): Judgement {
  const { feedback } = step;
  const verdict = (correct: boolean, specific?: string): Judgement => {
    if (correct && 'correct' in feedback) return { correct, feedback: feedback.correct };
    if (step.kind === 'simulation') return { correct, feedback: step.feedback.incomplete };
    const fallback = 'incorrect' in feedback ? feedback.incorrect : '';
    return { correct, feedback: specific ?? fallback };
  };
  switch (step.kind) {
    case 'numeric': {
      const x = value as number;
      if (Math.abs(x - step.answer) <= step.tolerance) return verdict(true);
      return verdict(false, x < step.answer ? step.feedback.low : step.feedback.high);
    }
    case 'single_choice': {
      const picked = step.options.find((o) => o.id === value);
      return verdict(value === step.correct, picked?.feedback);
    }
    case 'multiple_choice': {
      const picked = value as string[];
      const correct =
        picked.length === step.correct.length && picked.every((id) => step.correct.includes(id));
      const wrong = step.options.find((o) => picked.includes(o.id) && !step.correct.includes(o.id));
      return verdict(correct, wrong?.feedback);
    }
    case 'ordering':
      return verdict((value as string[]).every((id, i) => step.order[i] === id));
    case 'matching': {
      const pairs = value as Record<string, string>;
      return verdict(Object.entries(step.pairs).every(([k, v]) => pairs[k] === v));
    }
    case 'simulation': {
      const seen = new Set([...compared, (value as { value: number }).value]);
      return verdict(step.compare.every((v) => seen.has(v)));
    }
    case 'text':
    case 'code':
      return { correct: true, feedback: step.feedback.saved };
  }
}

/** Steps completed by saving a written response rather than by a check. */
export const savedByComplete = (step: ExerciseStep) => step.kind === 'text' || step.kind === 'code';
