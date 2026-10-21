import {
  type ExerciseStep,
  exerciseStep,
  exerciseStepView,
  interactiveProblems,
  isInteractiveKind,
  type Judgement,
  judge,
  parseResponse,
  revealOf,
  viewStep,
} from '@parallax/contracts';
import { useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import exercise from '../exercises/Exercise.module.css';
import {
  type InteractiveDraft,
  interactiveDraft,
  interactiveResponse,
  mixDraft,
} from '../exercises/interactive/draft';
import { InteractiveForm } from '../exercises/interactive/InteractiveForm';
import { tween } from '../exercises/interactive/motion';
import local from './Authoring.module.css';

/** The preview uses one fixed shuffle, so it does not reorder while the author types. */
const PREVIEW_SEED = 1;
const PROMPT_PLACEHOLDER = 'The prompt appears here.';

/**
 * The step the form describes, when its own fields make a valid interactive step; otherwise
 * null. Title, prompt, hints and solution have their own fields, so the preview does not wait
 * for them.
 */
export function previewStep(content: unknown): ExerciseStep | null {
  if (!content || typeof content !== 'object') return null;
  const { title, prompt } = content as { title?: unknown; prompt?: unknown };
  const parsed = exerciseStep.safeParse({
    ...content,
    title: typeof title === 'string' && title.trim() ? title : 'Untitled step',
    prompt: typeof prompt === 'string' && prompt.trim() ? prompt : PROMPT_PLACEHOLDER,
    hints: [],
    solution: undefined,
  });
  if (!parsed.success || !isInteractiveKind(parsed.data.kind)) return null;
  const step = parsed.data as Parameters<typeof interactiveProblems>[0];
  return interactiveProblems(step).length === 0 ? parsed.data : null;
}

/**
 * The step as a student will meet it, answered and checked here in the browser with the
 * server's own rules (§9): nothing is recorded. Show answer moves the expected answer into place.
 */
export function InteractivePreview({ n, step }: { n: number; step: ExerciseStep }) {
  // Through the view schema, as the server sends it: the student sees exactly this.
  const view = exerciseStepView.parse(viewStep(step, PREVIEW_SEED)).interactive;
  const [draft, setDraft] = useState<InteractiveDraft | null>(() =>
    view ? interactiveDraft(view, undefined) : null,
  );
  const [result, setResult] = useState<Judgement | { problem: string } | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const stop = useRef<() => void>(() => {});
  if (!view || !draft) return null;

  const change = (next: InteractiveDraft) => {
    stop.current();
    setDraft(next);
    setResult(null);
  };
  const tryIt = () => {
    const built = interactiveResponse(view, draft);
    if (!built.ok) return setResult({ problem: built.message });
    const parsed = parseResponse(step, built.response);
    if (!parsed.ok) return setResult({ problem: parsed.message });
    setResult(judge(step, parsed.value));
  };
  const reveal = revealOf(step);
  const showAnswer = () => {
    const from = latest.current;
    if (!from || reveal === null) return;
    const to = interactiveDraft(view, reveal);
    setResult(null);
    stop.current();
    stop.current = tween(700, (t) => setDraft(mixDraft(from, to, t)));
  };
  const parts = result && 'parts' in result ? result.parts : null;

  return (
    <section className={local.card} aria-label={`Preview of step ${n}`}>
      <p className={local.hint}>Preview: answer it as a student would. Nothing here is recorded.</p>
      <p className={exercise.prompt}>{step.prompt}</p>
      <InteractiveForm
        view={view}
        draft={draft}
        disabled={false}
        parts={parts}
        label={step.title || `Step ${n}`}
        onChange={change}
      />
      <div className={exercise.actions}>
        <button type="button" className={buttons.outline} onClick={tryIt}>
          {step.kind === 'drawing' || step.kind === 'explore' ? 'Try saving' : 'Try checking'}
        </button>
        {reveal !== null ? (
          <button type="button" className={buttons.textButton} onClick={showAnswer}>
            Show the expected answer
          </button>
        ) : null}
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => change(interactiveDraft(view, undefined))}
        >
          Start over
        </button>
      </div>
      <div role="status">
        {result ? (
          <div className={exercise.feedback}>
            {'problem' in result ? (
              <p>{result.problem}</p>
            ) : (
              <>
                <strong>{result.correct ? 'Correct.' : 'Not yet.'}</strong>
                <p>{result.feedback}</p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
