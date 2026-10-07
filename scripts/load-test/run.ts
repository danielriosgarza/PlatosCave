/**
 * Load test (spec §14): a class of 200 seeded students starts one test within a minute and runs
 * its sample tests, against a running API and runner. Needs the server started with
 * TEST_ROUTES=1 (fixture sign-in and world) and a runner draining `execution.run`.
 *
 *   BASE_URL=http://127.0.0.1:3000 pnpm load-test
 *
 * Environment: STUDENTS (200), WINDOW_SECONDS (60), RUN_DEADLINE_SECONDS (900), SUMMARY_FILE.
 * Exits 1 when a p95 is over its §14 budget or a student ends without a result.
 */
import { appendFileSync } from 'node:fs';
import { BUDGETS, markdown, passed, summarise } from './report';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const STUDENTS = Number(process.env.STUDENTS ?? 200);
const WINDOW_MS = Number(process.env.WINDOW_SECONDS ?? 60) * 1000;
const DEADLINE_MS = Number(process.env.RUN_DEADLINE_SECONDS ?? 900) * 1000;
const POLL_MS = 2000;
const TERMINAL = new Set([
  'passed',
  'failed',
  'time_limited',
  'resource_exhausted',
  'cancelled',
  'infrastructure_error',
]);

const definition = {
  schema: 'test.v1',
  settings: { attempts: 1, timeZone: 'Europe/Madrid' },
  questions: [
    {
      id: 'spread',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 1,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
      correct: ['n100'],
    },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 2,
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
      ],
      checks: [
        {
          name: 'sample',
          kind: 'call',
          visibility: 'public',
          file: 'solution.py',
          function: 'mean',
          args: [[1, 2, 3]],
          expected: { value: 2 },
          compare: { mode: 'numeric' },
        },
      ],
    },
  ],
};
const SOLUTION = 'def mean(xs):\n    return sum(xs) / len(xs)\n';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Responses are checked by use, not by schema: the script reports what the API answers.
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from the API under test
type Json = any;

class Client {
  private cookie = '';
  async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json; ms: number }> {
    const started = performance.now();
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(this.cookie && { cookie: this.cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (set.length) this.cookie = set.join('; ');
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json, ms };
  }
  async ok(method: string, path: string, body?: unknown) {
    const r = await this.call(method, path, body);
    if (r.status >= 300) {
      throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
    return r;
  }
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

const samples: Record<string, number[]> = {
  overview: [],
  start: [],
  save: [],
  enqueue: [],
  queueWait: [],
};
const failures: string[] = [];
let queuePositionSeen = false;
let maxQueuePosition = 0;

async function student(c: Client, n: number, classId: string, resourceId: string) {
  const who = `student ${n}`;
  try {
    const overview = await c.ok('GET', `/api/classes/${classId}/resources/${resourceId}/test`);
    samples.overview?.push(overview.ms);
    const started = await c.call(
      'POST',
      `/api/classes/${classId}/resources/${resourceId}/test-attempts`,
    );
    samples.start?.push(started.ms);
    if (started.status >= 300) throw new Error(`start attempt -> ${started.status}`);
    const attemptId: string = started.json.id;
    const base = `/api/classes/${classId}/test-attempts/${attemptId}`;
    const saved = await c.call('PUT', `${base}/answers/spread`, {
      value: ['n100'],
      flagged: false,
      seq: 1,
    });
    samples.save?.push(saved.ms);
    if (saved.status >= 300) throw new Error(`save answer -> ${saved.status}`);

    const run = await c.call('POST', `${base}/questions/mean/runs`, {
      files: [{ path: 'solution.py', content: SOLUTION }],
    });
    samples.enqueue?.push(run.ms);
    if (run.status >= 300)
      throw new Error(`request run -> ${run.status} ${JSON.stringify(run.json)}`);
    const queuedAt = performance.now();
    let view = run.json;
    while (!TERMINAL.has(view.state)) {
      if (view.queuePosition !== undefined) {
        queuePositionSeen = true;
        maxQueuePosition = Math.max(maxQueuePosition, view.queuePosition);
      }
      if (performance.now() - queuedAt > DEADLINE_MS) {
        throw new Error(`run still ${view.state} after ${DEADLINE_MS / 1000} s`);
      }
      // A queued run must say where it waits; silence is the failure §14 forbids.
      if (
        view.state === 'queued' &&
        view.queuePosition === undefined &&
        performance.now() - queuedAt > 90_000
      ) {
        throw new Error('run queued for 90 s without a queue position');
      }
      await sleep(POLL_MS + Math.random() * 500);
      view = (await c.ok('GET', `${base}/runs/${view.runId}`)).json;
    }
    samples.queueWait?.push(performance.now() - queuedAt);
    if (view.state !== 'passed') throw new Error(`run ended ${view.state}`);
  } catch (err) {
    failures.push(`${who}: ${(err as Error).message}`);
  }
}

async function main() {
  const run = Date.now().toString(36);
  console.log(`Seeding ${STUDENTS} students against ${BASE}`);
  const anon = new Client();
  const { ids } = (await anon.ok('POST', '/api/test/world')).json as {
    ids: Record<string, string>;
  };

  const elena = new Client();
  await elena.ok('POST', '/api/test/signin-as', { email: 'elena@example.test' });
  const created = await elena.ok(
    'POST',
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    {
      type: 'test',
      title: `Load test ${run}`,
      content: definition,
    },
  );
  const { release } = (await elena.ok('POST', `/api/courses/${ids.statistics}/releases`)).json;
  const priya = new Client();
  await priya.ok('POST', '/api/test/signin-as', { email: 'priya@example.test' });
  const current = (await priya.ok('GET', `/api/classes/${ids.classA}/release`)).json;
  await priya.ok('POST', `/api/classes/${ids.classA}/adopt`, {
    releaseId: release.id,
    expectedReleaseId: current.release.id,
  });
  const invite = (
    await elena.ok('POST', `/api/classes/${ids.classA}/invites`, {
      kind: 'enrolment',
      maxUses: STUDENTS + 10,
    })
  ).json;

  const clients = Array.from({ length: STUDENTS }, () => new Client());
  await inBatches(
    clients.map((c, i) => ({ c, i })),
    20,
    async ({ c, i }) => {
      await c.ok('POST', '/api/test/signin-as', { email: `load-${run}-${i}@example.test` });
      await c.ok('POST', '/api/join', { code: invite.code });
    },
  );

  console.log(`Starting the test: arrivals spread over ${WINDOW_MS / 1000} s`);
  const began = performance.now();
  await Promise.all(
    clients.map(async (c, i) => {
      await sleep((i / STUDENTS) * WINDOW_MS + Math.random() * 200);
      await student(c, i, ids.classA as string, created.json.id);
    }),
  );
  const seconds = Math.round((performance.now() - began) / 1000);

  const rows = summarise(samples, BUDGETS);
  if (!queuePositionSeen) {
    failures.push(
      'no run ever reported a queue position (runner slots may be too many for the load)',
    );
  }
  const text = markdown(rows, {
    students: STUDENTS,
    windowSeconds: WINDOW_MS / 1000,
    failures,
    queuePositionSeen,
  });
  const report = `${text}\n\nLongest queue position seen: ${maxQueuePosition}. Whole run: ${seconds} s.`;
  console.log(report);
  if (process.env.SUMMARY_FILE) appendFileSync(process.env.SUMMARY_FILE, `${report}\n`);
  process.exit(passed(rows, failures) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
