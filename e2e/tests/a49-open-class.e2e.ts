import { type APIRequestContext, expect, test } from '@playwright/test';
import { latestSignInLink } from './mail';
import { signedIn } from './released';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { course: id(111), topic: id(311), native: id(411), nativeRevision: id(511) };
const OFF = 'Questions and comments are off in this open class.';
const post = async (who: APIRequestContext, url: string, data: object) =>
  (await (await who.post(url, { data })).json()) as Record<string, string>;

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
  const { id: classId } = await post(owner, `/api/courses/${lab.course}/classes`, { name: unique });
  const at = `/api/classes/${classId}`;
  const teach = { kind: 'instructor', email: 'lab-instructor@example.test' };
  const { code: token } = await post(owner, `${at}/invites`, teach);
  expect(await post(teacher, '/api/invitations/accept', { token })).toMatchObject({ classId });
  const adopt = { releaseId: id(611), expectedReleaseId: null };
  expect(await post(teacher, `${at}/adopt`, adopt)).toMatchObject({ releaseId: id(611) });
  expect((await owner.put(`${at}/open`, { data: { open: true } })).ok()).toBe(true);
  const { code } = await post(owner, `${at}/invites`, { kind: 'enrolment' });

  // The link asks a signed-out visitor to sign in first and comes back to the join page.
  const email = `visitor-${unique}@example.test`;
  await page.goto(`/join/${code}`);
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
  await expect(page.getByRole('heading', { name: 'Join a class' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Invitation code' })).toHaveValue(String(code));
  await page.getByRole('button', { name: 'Join class' }).click();
  await expect(page).toHaveURL(new RegExp(`/classes/${classId}/topics`));

  // The reading: a selected passage offers Highlight and Note, no Ask, and no composer.
  const topic = `/classes/${classId}/topics/${lab.topic}`;
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  await page.getByText('Paragraph 2.', { exact: false }).first().dblclick();
  const tools = page.getByRole('toolbar', { name: 'Selected passage' });
  await expect(tools.getByRole('button')).toHaveText(['Highlight', 'Note']);
  await tools.getByRole('button', { name: 'Note' }).click();
  await page.getByRole('textbox', { name: 'Your note' }).fill('Private in an open class');
  const saved = page.getByRole('status').filter({ hasText: 'Saved' });
  await expect(saved).toBeVisible({ timeout: 10_000 });
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
  const resource = `${at}/resources/${lab.native}`;
  const asked = { audience: 'class', anchor: { kind: 'none' }, body: 'Anyone else stuck?' };
  expect(await post(page.request, `${resource}/threads`, asked)).toEqual({ error: 'class_open' });
  expect(await (await page.request.get(`${resource}/annotations`)).json()).toMatchObject({
    annotations: [{ kind: 'note', audience: 'private', body: 'Private in an open class' }],
    threads: [],
  });
});
