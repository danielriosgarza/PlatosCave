import {
  checkStep,
  completeStep,
  openExercise,
  readExercise,
  restartExercise,
  showHint,
  showSolution,
} from '@parallax/contracts/routes/exercises';
import { getClassRelease } from '@parallax/contracts/routes/releases';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../api/client';
import { refreshProgress } from '../topics/progress';

export type Attempt = z.output<typeof openExercise.response>;
export type AttemptStep = Attempt['steps'][number];
/** An exercise's steps without an attempt; nothing in it is recorded. */
export type ExerciseView = z.output<typeof readExercise.response>;
export type ExerciseStepView = ExerciseView['steps'][number];
export type ClassRelease = z.output<typeof getClassRelease.response>;
export type ReleasedResource = ClassRelease['topics'][number]['resources'][number];

/** The released exercises of a topic, with their release times (§4, §9). */
export const useClassRelease = (classId: string) =>
  useApi(getClassRelease, { params: { classId } });

/** Reads an exercise without starting an attempt: an archived class starts none (§4). */
export const useExerciseView = (classId: string, resourceId: string) =>
  useApi(readExercise, { params: { classId, resourceId } });

const attemptKey = (classId: string, resourceId: string) => [
  'exercise-attempt',
  classId,
  resourceId,
];

/** Resumes the caller's current attempt, or starts the first one; the server owns the state. */
export function useAttempt(classId: string, resourceId: string) {
  return useQuery({
    queryKey: attemptKey(classId, resourceId),
    queryFn: () => call(openExercise, { params: { classId, resourceId } }),
    // The attempt only changes through this tab's own actions, which write the answer back.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** What the person is told when an action did not reach a recorded answer. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; error?: unknown } | null;
    if (error.status === 400 && typeof body?.message === 'string') return body.message;
    if (error.status === 409 && body?.error === 'class_archived') {
      return 'This class is archived, so practice is read-only.';
    }
    if (error.status === 404) return 'This exercise is no longer open to you.';
  }
  return 'That could not be recorded. Check your connection and try again.';
}

type StepBody = { stepId: string };

/**
 * The actions on an attempt. Each one writes the server's attempt view back to the cache; a
 * stale tab (409 `revision_conflict`) is moved to the current attempt and told so through
 * `setNotice`, which lives above the per-attempt view that the move remounts. Nothing is
 * shown as recorded until the server has answered.
 */
export function useAttemptActions(
  classId: string,
  resourceId: string,
  attempt: Attempt,
  setNotice: (notice: string | null) => void,
) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const params = { classId, attemptId: attempt.id };
  const store = (next: Attempt) => {
    queryClient.setQueryData(attemptKey(classId, resourceId), next);
    // A finished attempt may complete a topic whose exercise is assigned for credit (§4).
    if (next.completedAt) refreshProgress(queryClient);
  };

  const guard = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await run();
    } catch (failure) {
      const body = failure instanceof ApiError ? (failure.body as { error?: string } | null) : null;
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        body?.error === 'revision_conflict'
      ) {
        const { current } = failure.body as { current: Attempt };
        store(current);
        setNotice('Your practice was started again elsewhere. This is your current attempt.');
        return undefined;
      }
      setError(describe(failure));
      return undefined;
    }
  };

  const check = useMutation({
    mutationFn: (input: StepBody & { response: unknown }) =>
      guard(async () => {
        const out = await call(checkStep, { params, body: input });
        setNotice(null);
        store(out.attempt);
        return out;
      }),
  });
  const hint = useMutation({
    mutationFn: (input: StepBody) =>
      guard(async () => {
        const next = await call(showHint, { params, body: input });
        setNotice(null);
        store(next);
        return next;
      }),
  });
  const solution = useMutation({
    mutationFn: (input: StepBody) =>
      guard(async () => {
        const next = await call(showSolution, { params, body: input });
        setNotice(null);
        store(next);
        return next;
      }),
  });
  const complete = useMutation({
    mutationFn: (input: StepBody & { response: string }) =>
      guard(async () => {
        const next = await call(completeStep, { params, body: input });
        setNotice(null);
        store(next);
        return next;
      }),
  });
  const restart = useMutation({
    mutationFn: () =>
      guard(async () => {
        const next = await call(restartExercise, { params });
        setNotice(null);
        store(next);
        return next;
      }),
  });

  return {
    check: check.mutateAsync,
    hint: hint.mutateAsync,
    solution: solution.mutateAsync,
    complete: complete.mutateAsync,
    restart: restart.mutateAsync,
    busy:
      check.isPending ||
      hint.isPending ||
      solution.isPending ||
      complete.isPending ||
      restart.isPending,
    error,
    clearError: () => setError(null),
  };
}
