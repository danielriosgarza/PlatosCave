import { expect, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { releaseToClassA, testDefinition, worldIds } from './tests/released';

export const exerciseDefinition = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'What happens to the standard error when n goes from 25 to 100?',
      options: [
        { id: 'half', label: 'It halves' },
        { id: 'same', label: 'It stays the same', feedback: 'The error depends on √n, not on n.' },
        { id: 'double', label: 'It doubles' },
      ],
      correct: 'half',
      hints: ['SE is proportional to 1 / √n.', 'Compare √25 with √100.'],
      solution: 'It halves: √100 is twice √25.',
      feedback: { correct: 'Yes, the standard error halves.', incorrect: 'Not quite.' },
    },
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare n = 100 with the baseline n = 25.',
      control: { name: 'n', label: 'Sample size', min: 25, max: 200, step: 25, initial: 25 },
      observations: [{ id: 'se', label: 'Standard error' }],
      compare: [25, 100],
      feedback: { correct: 'Both sample sizes compared.', incomplete: 'Now compare with n = 100.' },
    },
    {
      id: 'explain',
      kind: 'text',
      title: 'Explain',
      prompt: 'Which distribution narrowed, and which did not?',
      feedback: { saved: 'Saved. Your practice is complete.' },
    },
  ],
};

/** Releases a fresh exercise in Sampling to class A (see released.ts for the cross-worker handling). */
export async function releaseExercise(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  title: string,
) {
  const ids = await worldIds(playwright, baseURL);
  const [resourceId] = await releaseToClassA(playwright, baseURL, ids, [
    { type: 'exercise', title, content: exerciseDefinition },
  ]);
  return { ids, resourceId: resourceId as string };
}

export async function openExercise(page: Page, classId: string, topicId: string, title: string) {
  await page.goto(`/classes/${classId}/topics/${topicId}/exercises`);
  const start = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Start' });
  const predict = page.getByRole('heading', { name: 'Predict' });
  await expect(start.or(predict)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(predict).toBeVisible();
}

/** Visible matches of `selector` whose box is under 44 px either way, named for the failure message. */
export const small = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        const name =
          node.getAttribute('aria-label') ||
          node.textContent?.trim() ||
          node.getAttribute('name') ||
          node.tagName;
        return { name, box };
      })
      .filter(({ box }) => box.width > 0 && (box.height < 44 || box.width < 44))
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
  );

/** Releases a fresh test in Sampling to class A (see released.ts for the cross-worker handling). */
export async function releaseTest(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  title: string,
) {
  const ids = await worldIds(playwright, baseURL);
  const [resourceId] = await releaseToClassA(playwright, baseURL, ids, [
    { type: 'test', title, content: testDefinition },
  ]);
  return { ids, resourceId: resourceId as string };
}
