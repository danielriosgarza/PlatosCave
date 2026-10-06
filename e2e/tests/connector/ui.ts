import { expect, type Page } from '@playwright/test';
import { type Connector, codeFrom, fixtureKey, localPython, type Run } from './connector';
import { countPairing, type Person, personWithPairingLeft, takeTestStart } from './limits';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311) };
export const labClass = lab.class;
export const notebooks = `/classes/${lab.class}/topics/${lab.topic}/notebooks`;

export type { Person };

const emails: Record<Person, string> = {
  reader: 'lab-reader@example.test',
  instructor: 'lab-instructor@example.test',
};
const who = new WeakMap<Page, Person>();

/**
 * Test connection starts and pairing codes are limited per person (limits.ts): every start waits
 * for room in the last minute.
 */
export async function takeTestBudget(page: Page): Promise<void> {
  await takeTestStart(who.get(page) ?? 'reader', (ms) => page.waitForTimeout(ms));
}

/** Signs the lab reader in and opens the lab notebook's Connect panel. */
export async function openConnect(page: Page, preferred: Person = 'reader'): Promise<void> {
  // A retried test starts with the server's limits already partly used: the other person may pair.
  const person = personWithPairingLeft(preferred);
  who.set(page, person);
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: emails[person] },
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto(notebooks);
  await page.getByRole('button', { name: 'Saved outputs' }).click();
  await expect(page.getByRole('heading', { name: 'Connect a computer' })).toBeVisible();
}

/**
 * Pairs `connector` as the signed-in person: shows a code, runs `pair`, waits until the computer
 * is listed as waiting and approves it, either with the real Approve button or, for flows that
 * are not about approval, through the test route that calls the same service.
 */
export async function pairAndApprove(
  page: Page,
  connector: Connector,
  name: string,
  how: 'button' | 'route' = 'route',
): Promise<Run> {
  countPairing(who.get(page) ?? 'reader');
  await page.getByRole('button', { name: 'Pair a computer' }).click();
  const code = codeFrom(await page.getByText(/--code [0-9A-Z]{4}-[0-9A-Z]{4}/).innerText());
  const pairing = connector.pair(code, name);
  await pairing.waitFor(/Fingerprint: SHA256:/);
  const approve = page.getByRole('button', { name: `Approve ${name}` });
  if (how === 'button') {
    await expect(approve).toBeVisible({ timeout: 20_000 });
    await approve.click();
  } else {
    await expect(approve).toBeVisible({ timeout: 20_000 });
    const connectors = await page.request.get('/api/me/connectors');
    const rows = (await connectors.json()) as { id: string; name: string; status: string }[];
    const pending = rows.find((c) => c.name === name && c.status === 'pending');
    expect(pending, 'the pending connector is listed').toBeTruthy();
    const res = await page.request.post(`/api/test/connectors/${pending?.id}/approve`);
    expect(res.ok()).toBe(true);
  }
  await pairing.waitFor(/Paired|paired/, 30_000);
  expect(await pairing.exited).toBe(0);
  return pairing;
}

/** Runs the connector and waits until Parallax lists its computer as connected. */
export async function connect(page: Page, connector: Connector, name: string): Promise<Run> {
  const run = connector.run();
  await run.waitFor(/Connected to /);
  await expect(page.getByRole('list', { name: 'Your computers' }).getByText(name)).toBeVisible();
  return run;
}

/** Fills and submits the "This computer" form, then connects once the test passes. */
export async function connectLocal(page: Page, name: string, workspace: string): Promise<void> {
  await page.getByRole('radio', { name: 'This computer' }).check();
  await newConnection(page);
  await page.getByLabel('Connection name').fill(`${name} notebook`);
  await page.getByLabel('Working directory').fill(workspace);
  await page.getByLabel('Python interpreter (optional)').fill(localPython);
  await takeTestBudget(page);
  await page.getByRole('button', { name: 'Save and test connection' }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

/** The whole local path: pair (test route), connect, test, Connect, and wait until the notebook is live. */
export async function liveLocalNotebook(
  page: Page,
  connector: Connector,
  name: string,
): Promise<Run> {
  await openConnect(page);
  await pairAndApprove(page, connector, name);
  const run = await connect(page, connector, name);
  await connectLocal(page, name, connector.workspace());
  await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('article', { name: 'Live notebook' })).toBeVisible();
  return run;
}

/** Replaces the source of a code cell in the live notebook. */
export async function typeInCell(page: Page, cell: RegExp, source: string): Promise<void> {
  const notebook = page.getByRole('article', { name: 'Live notebook' });
  await notebook.getByRole('textbox', { name: cell }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(source);
}

export interface SshTarget {
  name: string;
  host: string;
  port: number;
  user: string;
  workspace: string;
  jump?: { host: string; port: number; user: string };
}

/** Fills the SSH form with the fixture key and starts Test connection. */
export async function testSsh(page: Page, o: SshTarget): Promise<void> {
  await page.getByRole('radio', { name: 'SSH host' }).check();
  await newConnection(page);
  await page.getByLabel('Connection name').fill(o.name);
  await page.getByLabel('Host', { exact: true }).fill(o.host);
  await page.getByLabel('Port', { exact: true }).fill(String(o.port));
  await page.getByLabel('Account', { exact: true }).fill(o.user);
  await page.getByLabel('Working directory').fill(o.workspace);
  if (o.jump) {
    await page.getByLabel('Reach this host through a jump host').check();
    await page.getByLabel('Jump host', { exact: true }).fill(o.jump.host);
    await page.getByLabel('Jump host port').fill(String(o.jump.port));
    await page.getByLabel('Jump host account').fill(o.jump.user);
  }
  await page.getByLabel('Key file path').fill(fixtureKey);
  await takeTestBudget(page);
  await page.getByRole('button', { name: 'Save and test connection' }).click();
}

/**
 * Confirms each first-use host key the test asks about (one per hop) and waits until the test
 * either offers Connect or ends in failure. The fingerprint is compared by the person; the test
 * trusts what the fixture presents because the fixture's keys are generated at start.
 */
export async function trustUntilDone(page: Page): Promise<void> {
  const trust = page.getByRole('button', { name: 'Trust this key' });
  const done = page
    .getByRole('button', { name: 'Connect', exact: true })
    .or(page.getByRole('button', { name: 'Test again' }));
  for (let hop = 0; hop < 3; hop++) {
    await trust.or(done).first().waitFor({ timeout: 120_000 });
    if (!(await trust.isVisible())) return;
    await takeTestBudget(page);
    await trust.click();
    await expect(trust).toBeHidden({ timeout: 30_000 });
  }
}

export function stage(page: Page, name: string) {
  return page.locator(`[data-stage="${name}"]`);
}

/** Connect, and wait until the kernel is idle. */
export async function connectAndWaitReady(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toBeVisible({
    timeout: 120_000,
  });
}

const OPEN = ['starting', 'ready', 'disconnected', 'unconfirmed', 'stopping'];

/**
 * Ends every open session of the signed-in person in the lab class, so the next test meets an
 * empty Connect panel: Stop while the connector is still connected, Forget for what cannot stop.
 */
export async function endSessions(page: Page): Promise<void> {
  const base = `/api/classes/${lab.class}/notebook-sessions`;
  const list = async () =>
    ((await (await page.request.get(base)).json()) as { id: string; state: string }[]).filter((s) =>
      OPEN.includes(s.state),
    );
  for (const s of await list())
    await page.request.post(`${base}/${s.id}/close`, { data: { stop: true } });
  const deadline = Date.now() + 30_000;
  while ((await list()).length > 0 && Date.now() < deadline) await page.waitForTimeout(500);
  for (const s of await list()) await page.request.post(`${base}/${s.id}/forget`);
  // The computers go too: the next test pairs its own, and an old one must not be the default.
  const computers = (await (await page.request.get('/api/me/connectors')).json()) as {
    id: string;
    status: string;
  }[];
  for (const c of computers.filter((c) => c.status !== 'revoked')) {
    await page.request.post(`/api/me/connectors/${c.id}/revoke`);
  }
}

/** A saved connection of an earlier test must not be edited by this one. */
async function newConnection(page: Page): Promise<void> {
  const saved = page.getByLabel('Saved connection');
  if (await saved.count()) await saved.selectOption('new');
}
