import { type APIRequestContext, expect, test } from '@playwright/test';

/** One browser-like client per person, signed in through the fixture route. */
async function signedIn(
  playwright: { request: { newContext(o: object): Promise<APIRequestContext> } },
  baseURL: string,
  email: string,
): Promise<APIRequestContext> {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

test('A02 a code joins a student, an invitation an instructor, each with only that role', async ({
  playwright,
  baseURL,
}) => {
  const base = baseURL ?? '';
  const setup = await playwright.request.newContext({ baseURL: base });
  const world = await (await setup.post('/api/test/world')).json();
  const classA: string = world.ids.classA;

  const owner = await signedIn(playwright, base, 'elena@example.test');
  const code = await (
    await owner.post(`/api/classes/${classA}/invites`, { data: { kind: 'enrolment' } })
  ).json();
  const unique = `${Date.now()}-${test.info().workerIndex}`;
  const studentEmail = `student-${unique}@example.test`;
  const student = await signedIn(playwright, base, studentEmail);
  const joined = await student.post('/api/join', { data: { code: code.code } });
  expect(await joined.json()).toMatchObject({ classId: classA, role: 'student' });
  // The enrolment code is not an instructor invitation.
  const misuse = await student.post('/api/invitations/accept', { data: { token: code.code } });
  expect(misuse.status()).toBe(404);
  expect((await student.get(`/api/classes/${classA}/members`)).status()).toBe(403);

  const teacherEmail = `teacher-${unique}@example.test`;
  const invite = await (
    await owner.post(`/api/classes/${classA}/invites`, {
      data: { kind: 'instructor', email: teacherEmail },
    })
  ).json();
  const teacher = await signedIn(playwright, base, teacherEmail);
  const accepted = await teacher.post('/api/invitations/accept', { data: { token: invite.code } });
  expect(await accepted.json()).toMatchObject({ classId: classA, role: 'instructor' });
  const me = await (await teacher.get('/api/me')).json();
  expect(me.courses).toEqual([expect.objectContaining({ editor: true, publisher: false })]);
});
