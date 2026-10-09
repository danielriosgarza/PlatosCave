import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { joinLabClassAs } from './lab-classmate';
import {
  exerciseDefinition,
  releaseToClassA,
  signedIn,
  testDefinition,
  type WorldIds,
  worldIds,
} from './released';

test.use({ colorScheme: 'light' });

let ids: WorldIds;
test.beforeAll(async ({ playwright, baseURL }) => {
  ids = await worldIds(playwright, baseURL);
});

/** Moves focus with Tab alone until `target` has it; fails if the control cannot be reached. */
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < 150; presses++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${target}`);
}

/** Reaches the control by Tab and activates it with the key a keyboard user would. */
async function activate(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter') {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** Moves among the topic's tabs the way the pattern asks: Tab to the strip, then arrow keys. */
async function chooseTab(page: Page, name: string) {
  const strip = page.getByRole('tablist');
  await tabTo(page, strip.getByRole('tab', { selected: true }));
  for (let steps = 0; steps < 10; steps++) {
    if (await strip.getByRole('tab', { name, selected: true }).count()) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(strip.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  await expect(strip.getByRole('tab', { name })).toBeFocused();
}

test('A20 a keyboard-only reader goes from the course list to a saved reading note', async ({
  page,
  playwright,
  baseURL,
}) => {
  await joinLabClassAs(playwright, baseURL, page.request, `a20-reader-${Date.now()}@example.test`);

  await page.goto('/courses?view=student');
  await activate(page, page.getByRole('link', { name: /^Open Reading lab/ }));
  await expect(page.getByRole('link', { name: 'Long readings' })).toBeVisible();
  await activate(page, page.getByRole('link', { name: 'Long readings' }));
  const tabs = page.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await chooseTab(page, 'Reading');
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  // A passage selected the way assistive technology does it; everything after is keys only.
  await page.evaluate(() => {
    const block = [...document.querySelectorAll('[data-block-id]')].find((b) =>
      b.textContent?.startsWith('Paragraph 2.'),
    );
    const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error('paragraph not found');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 11);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  const tools = page.getByRole('toolbar', { name: 'Selected passage' });
  await activate(page, tools.getByRole('button', { name: 'Note' }));
  const editor = page.getByRole('textbox', { name: 'Your note' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Keyboard note');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('A20 a keyboard-only student answers a test with code and finds the released feedback', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Keyboard test ${Date.now()}-${test.info().workerIndex}`;
  const [resourceId] = await releaseToClassA(playwright, baseURL, ids, [
    { type: 'test', title, content: testDefinition },
  ]);
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');

  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await page.goto('/courses?view=student');
  await activate(page, page.getByRole('link', { name: /^Open Statistical thinking/ }));
  await activate(page, page.getByRole('link', { name: /Sampling/ }).first());
  await chooseTab(page, 'Tests');
  const listed = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' });
  const heading = page.getByRole('heading', { name: title });
  await expect(listed.or(heading)).toBeVisible();
  if (await listed.isVisible()) await activate(page, listed);
  await activate(page, page.getByRole('button', { name: /^Start attempt/ }));
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeVisible();

  // One Tab stop for the group; the arrow key moves to the next option and selects it.
  await tabTo(page, page.getByRole('radio', { name: 'n = 10', exact: true }));
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'n = 100' })).toBeChecked();
  await expect(page.getByText(/^Saved \d/)).toBeVisible();
  await activate(page, page.getByRole('button', { name: /^Question 2/ }));
  await expect(page.getByRole('heading', { name: 'Question 2' })).toBeVisible();
  await tabTo(page, page.getByRole('textbox').first());
  await page.keyboard.type('Noise averages out.');
  await activate(page, page.getByRole('button', { name: /^Question 3/ }));
  await expect(page.getByRole('heading', { name: 'Question 3' })).toBeVisible();
  await activate(page, page.getByRole('button', { name: /Screen-reader mode/ }));
  const code = page.getByRole('textbox', { name: 'solution.py, your implementation' });
  await tabTo(page, code);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('def mean(xs):\n    return sum(xs) / len(xs)\n');
  await expect(page.getByText(/^Saved \d/)).toBeVisible();

  await activate(page, page.getByRole('button', { name: 'Review submission' }));
  await expect(page.getByRole('heading', { name: 'Review submission' })).toBeFocused();
  await activate(page, page.getByRole('button', { name: 'Submit test' }));
  await expect(page.getByRole('heading', { name: 'Test submitted' })).toBeVisible();

  // The instructor grades by hand and releases; the student then finds the feedback by keyboard.
  const overview = await (
    await page.request.get(`/api/classes/${ids.classA}/resources/${resourceId}/test`)
  ).json();
  const attemptId = overview.attempts[0].id as string;
  // What the keys entered is what the server holds, before anyone grades it.
  const held = JSON.stringify(
    await (await page.request.get(`/api/classes/${ids.classA}/test-attempts/${attemptId}`)).json(),
  );
  expect(held).toContain('n100');
  expect(held).toContain('Noise averages out.');
  expect(held).toContain('return sum(xs) / len(xs)');
  const gradeUrl = `/api/classes/${ids.classA}/test-attempts/${attemptId}/grade`;
  const draftResponse = await priya.post(gradeUrl, {
    data: {
      expectedGradeId: null,
      manual: [{ questionId: 'why', criteria: [{ id: 'averaging', points: 3 }] }],
      feedback: [{ target: { kind: 'attempt' }, text: 'Well argued.' }],
    },
  });
  expect(draftResponse.ok()).toBe(true);
  const drafted = await draftResponse.json();
  const overridden = await priya.post(`${gradeUrl}/override`, {
    data: { expectedGradeId: drafted.history[0].id, points: 9, reason: 'No runner attached' },
  });
  expect(overridden.ok()).toBe(true);
  const graded = await overridden.json();
  const released = await priya.post(`/api/classes/${ids.classA}/grade-releases`, {
    data: { grades: [{ attemptId, gradeId: graded.history[0].id }] },
  });
  expect(released.ok()).toBe(true);

  // Back to the topic's tab strip by keys: leave Tests and return, which reads the new release.
  await chooseTab(page, 'Slides');
  await chooseTab(page, 'Tests');
  await expect(listed.or(heading)).toBeVisible();
  if (await listed.isVisible()) await activate(page, listed);
  await activate(page, page.getByRole('button', { name: /^View feedback for attempt 1/ }));
  await expect(page.getByRole('heading', { name: /attempt 1 feedback/ })).toBeFocused();
  await expect(page.getByText('Well argued.')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await priya.dispose();
});

test('A20 a keyboard-only student completes an exercise', async ({ page, playwright, baseURL }) => {
  const title = `Keyboard exercise ${Date.now()}-${test.info().workerIndex}`;
  await releaseToClassA(playwright, baseURL, ids, [
    { type: 'exercise', title, content: exerciseDefinition },
  ]);

  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await page.goto(`/classes/${ids.classA}/topics/${ids.sampling}/slides`);
  await chooseTab(page, 'Exercises');
  const start = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Start' });
  const predict = page.getByRole('heading', { name: 'Predict' });
  await expect(start.or(predict)).toBeVisible();
  if (await start.isVisible()) await activate(page, start);
  await expect(predict).toBeVisible();

  await tabTo(page, page.getByRole('radio', { name: 'It halves' }));
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'It halves' })).toBeChecked();
  await activate(page, page.getByRole('button', { name: 'Check answer' }));
  await expect(page.getByText('Yes, the standard error halves.')).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Continue' }));
  await tabTo(page, page.getByLabel('Your explanation'));
  await page.keyboard.type('The distribution of sample means narrowed.');
  await activate(page, page.getByRole('button', { name: 'Done' }));
  await expect(page.getByText('Saved. Your practice is complete.')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('A20 a sheet keeps focus inside, closes on Escape and gives focus back to its opener', async ({
  page,
}) => {
  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await page.goto('/courses?view=student');
  const opener = page.getByRole('button', { name: 'Join a class' });
  await activate(page, opener);
  const sheet = page.getByRole('dialog', { name: 'Join a class' });
  await expect(sheet).toBeVisible();
  // Focus moves into the sheet: the code field has it, so typing reaches the field.
  const field = sheet.getByRole('textbox');
  await expect(field).toBeFocused();
  await page.keyboard.type('ABCD-EFGH');
  await expect(field).toHaveValue('ABCD-EFGH');
  // Real Tab presses never leave the sheet for the page behind it.
  for (let presses = 0; presses < 8; presses++) {
    await page.keyboard.press('Tab');
    await expect(sheet.locator(':focus')).toHaveCount(1);
  }
  // Tab from the last control wraps to the first, Shift+Tab from the first to the last, and the
  // page behind never takes focus.
  const controls = sheet.locator(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );
  // With a code typed, Join is enabled too: the field and the buttons give several controls.
  expect(await controls.count()).toBeGreaterThan(1);
  const first = controls.first();
  const last = controls.last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});
