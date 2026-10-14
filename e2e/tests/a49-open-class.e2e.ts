import { expect, test } from '@playwright/test';
import { latestSignInLink } from './mail';
import { signedIn } from './released';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { course: id(111), topic: id(311), native: id(411), nativeRevision: id(511) };
const OFF = 'Questions and comments are off in this open class.';

test('A49 a visitor joins an open class by its link; no composer, a post is refused, a private note saves', async ({
  page,
  playwright,
  baseURL,
}) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
  // A class of the reading lab of its own, opened by the course owner, so no other file meets it.
  const owner = await signedIn(playwright, baseURL, 'lab-author@example.test');
  const teacher = await signedIn(playwright, baseURL, 'lab-instructor@example.test');
  const unique = `${Date.now()}-${test.info().workerIndex}`;
  const made = await owner.post(`/api/courses/${lab.course}/classes`, {
    data: { name: `Open lab ${unique}` },
  });
  const classId = ((await made.json()) as { id: string }).id;
  const teach = await owner.post(`/api/classes/${classId}/invites`, {
    data: { kind: 'instructor', email: 'lab-instructor@example.test' },
  });
  const token = ((await teach.json()) as { code: string }).code;
  expect((await teacher.post('/api/invitations/accept', { data: { token } })).ok()).toBe(true);
  const adopted = await teacher.post(`/api/classes/${classId}/adopt`, {
    data: { releaseId: id(611), expectedReleaseId: null },
  });
  expect(adopted.ok()).toBe(true);
  const opened = await owner.put(`/api/classes/${classId}/open`, { data: { open: true } });
  expect(opened.ok()).toBe(true);
  const issued = await owner.post(`/api/classes/${classId}/invites`, {
    data: { kind: 'enrolment' },
  });
  const { code } = (await issued.json()) as { code: string };

  // The link asks a signed-out visitor to sign in first and comes back to the join page.
  const email = `visitor-${unique}@example.test`;
  await page.goto(`/join/${code}`);
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
  await expect(page.getByRole('heading', { name: 'Join a class' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Invitation code' })).toHaveValue(code);
  await page.getByRole('button', { name: 'Join class' }).click();
  await expect(page).toHaveURL(new RegExp(`/classes/${classId}/topics`));

  // The reading: a selected passage offers Highlight and Note, no Ask, and no composer.
  const topic = `/classes/${classId}/topics/${lab.topic}`;
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();
  await page.evaluate(() => {
    const block = document.querySelector('[data-block-id]');
    const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error('no paragraph');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 9);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  const tools = page.getByRole('toolbar', { name: 'Selected passage' });
  await expect(tools.getByRole('button')).toHaveText(['Highlight', 'Note']);
  await tools.getByRole('button', { name: 'Note' }).click();
  await page.getByRole('textbox', { name: 'Your note' }).fill('Private in an open class');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(page.getByText(OFF)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment or question' })).toHaveCount(0);

  // The slides have no composer either.
  await page.goto(`${topic}/slides`);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(page.getByText(OFF)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment or question' })).toHaveCount(0);

  // The server refuses a post the page does not offer; the note is held, private.
  const threads = `/api/classes/${classId}/resources/${lab.native}/threads`;
  const post = { audience: 'class', anchor: { kind: 'none' }, body: 'Anyone else stuck?' };
  const refused = await page.request.post(threads, { data: post });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ error: 'class_open' });
  const held = await page.request.get(
    `/api/classes/${classId}/resources/${lab.native}/annotations`,
  );
  expect(await held.json()).toMatchObject({
    annotations: [{ kind: 'note', audience: 'private', body: 'Private in an open class' }],
    threads: [],
  });
});
