import { type APIRequestContext, expect, type PlaywrightWorkerArgs } from '@playwright/test';

const labClassId = `00000000-0000-4000-8000-${(211).toString().padStart(12, '0')}`;

/**
 * Signs `page` (or any holder of a request context) in as a student who has just joined the reading lab class with an enrolment code
 * issued by the course owner, so a test gets a reader with no saved places, notes or questions
 * that no other test file shares.
 */
export async function joinLabClassAs(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  page: { request: APIRequestContext },
  email: string,
): Promise<void> {
  const owner = await playwright.request.newContext({ baseURL });
  expect(
    (await owner.post('/api/test/signin-as', { data: { email: 'lab-author@example.test' } })).ok(),
  ).toBe(true);
  const issued = await owner.post(`/api/classes/${labClassId}/invites`, {
    data: { kind: 'enrolment' },
  });
  expect(issued.ok()).toBe(true);
  const { code } = (await issued.json()) as { code: string };
  await owner.dispose();

  expect((await page.request.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  const joined = await page.request.post('/api/join', { data: { code } });
  expect(await joined.json()).toMatchObject({ classId: labClassId, role: 'student' });
}
