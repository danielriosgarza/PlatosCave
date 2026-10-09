import { expect, type Page, test } from '@playwright/test';
import { joinLabClassAs } from './lab-classmate';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), nativeRevision: id(511) };
const reading = `/classes/${lab.class}/topics/${lab.topic}/reading?resource=${lab.nativeRevision}`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

/** The reading's resource id, the key annotations are listed under. */
async function resourceOf(page: Page): Promise<string> {
  const list = await page.request.get(`/api/classes/${lab.class}/topics/${lab.topic}/readings`);
  const { readings } = (await list.json()) as {
    readings: { resourceId: string; revisionId: string }[];
  };
  const found = readings.find((r) => r.revisionId === lab.nativeRevision);
  expect(found).toBeDefined();
  return (found as { resourceId: string }).resourceId;
}

type Held = {
  annotations: { id: string; kind: string; audience: string; body: string | null }[];
  threads: { audience: string; posts: { body: string | null }[] }[];
};

const held = async (page: Page, resourceId: string): Promise<Held> => {
  const res = await page.request.get(
    `/api/classes/${lab.class}/resources/${resourceId}/annotations`,
  );
  expect(res.ok()).toBe(true);
  return (await res.json()) as Held;
};

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
  // The database is shared by every attempt of a run: begin each from an empty margin.
  const resourceId = await resourceOf(page);
  for (const a of (await held(page, resourceId)).annotations) {
    await page.request.delete(`/api/classes/${lab.class}/annotations/${a.id}`);
  }
});

/** Selects the first words of a paragraph, as a drag across them would. */
async function selectWords(page: Page, paragraph: number, chars: number) {
  await page.evaluate(
    ([n, count]) => {
      const block = [...document.querySelectorAll('[data-block-id]')].find((b) =>
        b.textContent?.startsWith(`Paragraph ${n}.`),
      );
      // Earlier marks split a block's text, so take its first text node wherever it sits.
      const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) throw new Error('paragraph not found');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, count as number);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [paragraph, chars] as const,
  );
}

/** The discussion entry holding `text`. Threads cannot be deleted, so earlier attempts' stay listed. */
const threadOf = (page: Page, text: string) =>
  page.locator('[class*="thread"]').filter({ hasText: text });

const tools = (page: Page) => page.getByRole('toolbar', { name: 'Selected passage' });

test('A03 a note acknowledged by the server is still there, marked, after a reload', async ({
  page,
}) => {
  await page.goto(reading);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();
  await selectWords(page, 2, 11);
  await tools(page).getByRole('button', { name: 'Note' }).click();

  const editor = page.getByRole('textbox', { name: 'Your note' });
  await expect(editor).toBeFocused();
  await editor.fill('Check the sample size claim');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });

  await page.reload();
  await expect(page.locator('mark[data-marks]').first()).toHaveText('Paragraph 2');
  await expect(page.getByText('Check the sample size claim')).toBeVisible();
  // A mark opens its entry with the saved text.
  await page.locator('mark[data-marks]').first().click();
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveValue(
    'Check the sample size claim',
  );
});

test('A05 a student highlights text, writes a private note and posts an instructor question', async ({
  page,
}) => {
  const question = `Is n or n − 1 used here? ${Date.now()}`;
  const resourceId = await resourceOf(page);
  await page.goto(reading);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  await selectWords(page, 2, 11);
  await tools(page).getByRole('button', { name: 'Highlight' }).click();
  await expect(page.locator('mark[data-marks]').first()).toHaveText('Paragraph 2');

  await selectWords(page, 3, 11);
  await tools(page).getByRole('button', { name: 'Note' }).click();
  await page.getByRole('textbox', { name: 'Your note' }).fill('Private thought');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });

  await selectWords(page, 3, 11);
  await tools(page).getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByRole('combobox', { name: 'Visible to' })).toHaveValue('instructor');
  await page.getByRole('textbox', { name: 'Comment or question' }).fill(question);
  await page.getByRole('button', { name: 'Post' }).click();
  // Threads cannot be deleted, so an earlier attempt's identical question may be listed too.
  await expect(threadOf(page, question).getByText('You → Instructor')).toBeVisible();

  // The server holds the highlight and the note as private, and the question as one thread.
  const stored = await held(page, resourceId);
  expect(stored.annotations.map((a) => [a.kind, a.audience, a.body])).toEqual([
    ['highlight', 'private', null],
    ['note', 'private', 'Private thought'],
  ]);
  const asked = stored.threads.filter((t) => t.posts[0]?.body === question);
  expect(asked.map((t) => t.audience)).toEqual(['instructor']);
  // The question does not carry the note's text, and the note stays out of the thread.
  expect(JSON.stringify(stored.threads)).not.toContain('Private thought');
});

test('A05 the instructor sees only the shared question, answers it and resolves it; the student reopens it', async ({
  page,
  playwright,
  baseURL,
}) => {
  const question = `Why does n − 1 appear? ${Date.now()}`;
  const privateNote = `Private ${Date.now()}`;
  const resourceId = await resourceOf(page);
  await page.goto(reading);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  await selectWords(page, 3, 11);
  await tools(page).getByRole('button', { name: 'Note' }).click();
  await page.getByRole('textbox', { name: 'Your note' }).fill(privateNote);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });
  await selectWords(page, 3, 11);
  await tools(page).getByRole('button', { name: 'Ask' }).click();
  await page.getByRole('textbox', { name: 'Comment or question' }).fill(question);
  await page.getByRole('button', { name: 'Post' }).click();
  // Threads cannot be deleted, so the previous test's question may be listed too: find this one.
  await expect(threadOf(page, question).getByText('You → Instructor')).toBeVisible();

  // The instructor reads the question; the student's private note is nowhere in what they get.
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-instructor@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
  const seen = await held(page, resourceId);
  expect(seen.annotations).toEqual([]);
  expect(JSON.stringify(seen)).not.toContain(privateNote);
  await page.goto(reading);
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  const entry = threadOf(page, question);
  await expect(entry.first()).toBeVisible();
  await entry.first().getByRole('button', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: /^Reply to/ }).fill('Because the mean is estimated.');
  await page.getByRole('button', { name: 'Post reply' }).click();
  await expect(entry.first().getByText('Because the mean is estimated.')).toBeVisible();
  await expect(entry.first().getByText('· Instructor', { exact: false }).first()).toBeVisible();
  await entry.first().getByRole('button', { name: 'Mark resolved' }).click();
  await expect(entry.first().getByText('Resolved')).toBeVisible();

  // The student sees the labelled response and may reopen their own question.
  await page.request.post('/api/test/signin-as', { data: { email: 'lab-reader@example.test' } });
  await page.goto(reading);
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  const mine = threadOf(page, question);
  await expect(mine.first().getByText('Because the mean is estimated.')).toBeVisible();
  await expect(mine.first().getByText('Resolved')).toBeVisible();
  await mine.first().getByRole('button', { name: 'Reopen' }).click();
  await expect(mine.first().getByText('Open', { exact: true })).toBeVisible();

  // A classmate of the same class sees neither the question nor the private note.
  const classmate = await page.context().browser()?.newContext({ baseURL });
  if (!classmate) throw new Error('no browser');
  const other = await classmate.newPage();
  await joinLabClassAs(playwright, baseURL, other.request, `classmate-${Date.now()}@example.test`);
  const unseen = await other.request.get(
    `/api/classes/${lab.class}/resources/${resourceId}/annotations`,
  );
  expect(unseen.ok()).toBe(true);
  const unseenBody = JSON.stringify(await unseen.json());
  expect(unseenBody).not.toContain(question);
  expect(unseenBody).not.toContain(privateNote);
  await other.goto(reading);
  await expect(other.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();
  await other.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(other.getByText(question)).toHaveCount(0);
  await expect(other.getByText(privateNote)).toHaveCount(0);
  await expect(other.locator('mark[data-marks]')).toHaveCount(0);
  await classmate.close();
});
