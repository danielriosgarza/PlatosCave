import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { small } from '../touch';
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

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { course: id(111), class: id(211), topic: id(311), nativeRevision: id(511) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

/** One unbroken line, as typed into a text box: it must wrap in the review, not scroll sideways. */
const LONG_EXPLANATION = `Noise averages out.${' The larger sample averages more independent draws,'.repeat(6).replaceAll(' ', '_')}`;

interface Fixtures {
  ids: WorldIds;
  exerciseTitle: string;
  testTitle: string;
  reviewUrl: string;
  /** Review of a graded, unreleased attempt: the single-release preview opens from it. */
  draftReviewUrl: string;
  /** Priya's review of the class with the graded, unreleased test chosen. */
  bulkReviewUrl: string;
  /** Everything on this test is released, so "Needs review" has nothing to show. */
  nothingToReviewUrl: string;
  releasedTitle: string;
  tests: string;
  /** The test Sam's closed attempt belongs to, with an instructor request and kept unsent work. */
  recoveryTitle: string;
  /** A closed attempt of the recovery test that an instructor asked for; its unsent work is in Sam's browser only. */
  heldAttempt: string;
  examReviewUrl: (tab: string) => string;
  commentsUrl: string;
}
let fixtures: Fixtures;

/** The choice and written-answer questions only: the code question needs the runner (not in e2e). */
const gradedDefinition = { ...testDefinition, questions: testDefinition.questions.slice(0, 2) };

/** Sam starts, answers and submits a test the way a student would; returns the attempt id. */
async function submitAs(
  sam: APIRequestContext,
  classId: string,
  resourceId: string,
  answers: readonly (readonly [string, unknown])[],
): Promise<string> {
  const started = await sam.post(`/api/classes/${classId}/resources/${resourceId}/test-attempts`);
  expect(started.ok()).toBe(true);
  const attemptId = ((await started.json()) as { id: string }).id;
  const attempt = `/api/classes/${classId}/test-attempts/${attemptId}`;
  for (const [question, value] of answers) {
    expect(
      (await sam.put(`${attempt}/answers/${question}`, { data: { value, seq: 1 } })).ok(),
    ).toBe(true);
  }
  expect(
    (
      await sam.post(`${attempt}/submit`, {
        data: { submissionKey: `routes-${Date.now()}-${attemptId}` },
      })
    ).ok(),
  ).toBe(true);
  return attemptId;
}

/** Priya saves a complete draft grade (full marks on the written answer); returns its row id. */
async function draftGrade(priya: APIRequestContext, classId: string, attemptId: string) {
  const saved = await priya.post(`/api/classes/${classId}/test-attempts/${attemptId}/grade`, {
    data: {
      expectedGradeId: null,
      manual: [{ questionId: 'why', criteria: [{ id: 'averaging', points: 3 }] }],
      feedback: [{ target: { kind: 'attempt' }, text: 'Clear reasoning about averaging out.' }],
    },
  });
  expect(saved.ok()).toBe(true);
  const id = ((await saved.json()) as { history: { id: string }[] }).history[0]?.id;
  if (!id) throw new Error('the saved draft grade has no history row');
  return id;
}

test.beforeAll(async ({ playwright, baseURL }) => {
  const ids = await worldIds(playwright, baseURL);
  const stamp = `${Date.now()}-${test.info().workerIndex}`;
  const exerciseTitle = `Routes exercise ${stamp}`;
  const testTitle = `Routes test ${stamp}`;
  const submittedTitle = `Routes submitted ${stamp}`;
  const releasedTitle = `Routes released ${stamp}`;
  const draftTitle = `Routes draft ${stamp}`;
  const [exerciseId, , submittedId, releasedId, draftId] = await releaseToClassA(
    playwright,
    baseURL,
    ids,
    [
      { type: 'exercise', title: exerciseTitle, content: exerciseDefinition },
      { type: 'test', title: testTitle, content: testDefinition },
      { type: 'test', title: submittedTitle, content: testDefinition },
      { type: 'test', title: releasedTitle, content: gradedDefinition },
      { type: 'test', title: draftTitle, content: gradedDefinition },
    ],
  );
  if (!exerciseId || !submittedId || !releasedId || !draftId) {
    throw new Error('the fixture resources were not created');
  }
  const sam = await signedIn(playwright, baseURL, 'sam@example.test');
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  // Sam submits a test, so the class review has a submission to show.
  const attemptId = await submitAs(sam, ids.classA, submittedId, [
    ['spread', ['n100']],
    ['why', LONG_EXPLANATION],
    [
      'mean',
      {
        files: [{ path: 'solution.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }],
      },
    ],
  ]);
  // A closed attempt with an instructor's request for unsent work and the copy Sam's browser kept.
  const requested = await priya.post(
    `/api/classes/${ids.classA}/test-attempts/${attemptId}/recovery-request`,
    { data: { reason: 'The connection dropped before the deadline' } },
  );
  expect(requested.ok()).toBe(true);
  const kept = await sam.post(`/api/classes/${ids.classA}/test-attempts/${attemptId}/local-copy`, {
    data: {
      answers: [{ questionId: 'why', value: 'Unsent: a larger sample averages out noise.' }],
    },
  });
  expect(kept.ok()).toBe(true);
  // A graded and released test: Sam reads the feedback.
  const answers = [
    ['spread', ['n100']],
    ['why', 'Noise averages out in a larger sample.'],
  ] as const;
  const releasedAttempt = await submitAs(sam, ids.classA, releasedId, answers);
  const releasedGrade = await draftGrade(priya, ids.classA, releasedAttempt);
  const released = await priya.post(`/api/classes/${ids.classA}/grade-releases`, {
    data: { grades: [{ attemptId: releasedAttempt, gradeId: releasedGrade }] },
  });
  expect(released.ok()).toBe(true);
  // A graded test that is not released yet: both release previews open from it.
  const draftAttempt = await submitAs(sam, ids.classA, draftId, answers);
  await draftGrade(priya, ids.classA, draftAttempt);
  // Exercise review needs a practice attempt.
  expect(
    (await sam.post(`/api/classes/${ids.classA}/resources/${exerciseId}/exercise-attempt`)).ok(),
  ).toBe(true);
  // A second closed attempt that an instructor asked for, with no copy kept on the server: the
  // student's browser still holds the unsent answers (seeded when the route loads).
  const heldAttempt = await submitAs(sam, ids.classA, submittedId, [['spread', ['n10']]]);
  expect(
    (
      await priya.post(`/api/classes/${ids.classA}/test-attempts/${heldAttempt}/recovery-request`, {
        data: { reason: 'Please send what you typed after the last save' },
      })
    ).ok(),
  ).toBe(true);
  await priya.dispose();
  await sam.dispose();
  // A student of the lab class who shared a question: nobody else's cleanup removes it.
  const asker = await playwright.request.newContext({ baseURL });
  await joinLabClassAs(playwright, baseURL, { request: asker }, `asker-${stamp}@example.test`);
  const askerId = ((await (await asker.get('/api/me')).json()) as { user: { id: string } }).user.id;
  const readings = (await (
    await asker.get(`/api/classes/${lab.class}/topics/${lab.topic}/readings`)
  ).json()) as { readings: { resourceId: string; revisionId: string }[] };
  const reading = readings.readings.find((r) => r.revisionId === lab.nativeRevision);
  if (!reading) throw new Error('the lab reading was not found');
  const note = await asker.post(
    `/api/classes/${lab.class}/resources/${reading.resourceId}/annotations`,
    {
      data: {
        kind: 'note',
        anchor: { kind: 'none' },
        body: 'Why does the margin of error shrink?',
      },
    },
  );
  expect(note.ok()).toBe(true);
  const shared = await asker.post(
    `/api/classes/${lab.class}/annotations/${((await note.json()) as { id: string }).id}/share`,
    { data: { audience: 'instructor' } },
  );
  expect(shared.ok()).toBe(true);
  await asker.dispose();
  const reviewBase = `/classes/${ids.classA}/review`;
  fixtures = {
    ids,
    exerciseTitle,
    testTitle,
    reviewUrl: `${reviewBase}?assignment=${submittedId}&selected=${ids.sam}&attempt=${attemptId}`,
    draftReviewUrl: `${reviewBase}?assignment=${draftId}&selected=${ids.sam}&attempt=${draftAttempt}`,
    bulkReviewUrl: `${reviewBase}?assignment=${draftId}`,
    nothingToReviewUrl: `${reviewBase}?assignment=${releasedId}&needsReview=true`,
    releasedTitle,
    examReviewUrl: (tab) => `${reviewBase}?selected=${ids.sam}&tab=${tab}`,
    tests: `/classes/${ids.classA}/topics/${ids.sampling}/tests`,
    recoveryTitle: submittedTitle,
    heldAttempt,
    commentsUrl: `/classes/${lab.class}/review?selected=${askerId}&tab=comments`,
  };
});

type Route = {
  name: string;
  as: string | null;
  path: (f: Fixtures) => string;
  /** Opens the state worth checking and resolves once the content, not just the tab label, shows. */
  load: (page: Page, f: Fixtures) => Promise<void>;
};

const shown = (locator: Locator) => expect(locator.first()).toBeVisible();

/** Writes the browser-side copy of unsent answers the application keeps for a closed attempt. */
async function keepUnsentWork(page: Page, f: Fixtures) {
  const me = (await (await page.request.get('/api/me')).json()) as { user: { id: string } };
  const copy = {
    key: `attempt-copy|${me.user.id}|${f.ids.classA}|${f.heldAttempt}`,
    userId: me.user.id,
    kind: 'attempt-copy',
    classId: f.ids.classA,
    attemptId: f.heldAttempt,
    answers: [{ questionId: 'why', value: 'Typed after the last save.' }],
    updatedAt: Date.now(),
  };
  await page.goto('/signin');
  await page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('parallax-drafts', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts', { keyPath: 'key' });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put(record);
          tx.oncomplete = () => {
            request.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    copy,
  );
  await page.goto(f.tests);
}

/** From the tests list of a topic, opens the one with this title. */
async function openTest(page: Page, title: string) {
  const listed = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' });
  const heading = page.getByRole('heading', { name: title });
  await expect(listed.or(heading).first()).toBeVisible();
  if (await listed.isVisible()) await listed.click();
}

/** Every screen the application routes to, with real content on it, as the person who sees it. */
const routes: Route[] = [
  {
    name: 'sign-in',
    as: null,
    path: () => '/signin',
    load: (page) => shown(page.getByRole('heading', { name: 'Sign in' })),
  },
  {
    name: 'courses (student)',
    as: 'lab-reader',
    path: () => '/courses?view=student',
    load: (page) => shown(page.getByRole('link', { name: /^Open Reading lab/ })),
  },
  {
    name: 'courses (instructor)',
    as: 'lab-author',
    path: () => '/courses?view=instructor',
    load: (page) => shown(page.getByRole('heading', { name: 'Courses you teach' })),
  },
  {
    name: 'topics',
    as: 'lab-reader',
    path: () => `/classes/${lab.class}/topics`,
    load: (page) => shown(page.getByRole('link', { name: 'Long readings' })),
  },
  {
    name: 'slides',
    as: 'lab-reader',
    path: () => `${topic}/slides`,
    load: (page) => shown(page.getByLabel(/^Slide \d+ of \d+$/)),
  },
  {
    name: 'reading',
    as: 'lab-reader',
    path: () => `${topic}/reading?resource=${lab.nativeRevision}`,
    load: (page) => shown(page.locator('[data-block-id]')),
  },
  {
    name: 'exercise',
    as: 'sam',
    path: (f) => `/classes/${f.ids.classA}/topics/${f.ids.sampling}/exercises`,
    load: async (page, f) => {
      const start = page
        .getByRole('listitem')
        .filter({ hasText: f.exerciseTitle })
        .getByRole('button', { name: 'Start' });
      const predict = page.getByRole('heading', { name: 'Predict' });
      await expect(start.or(predict)).toBeVisible();
      if (await start.isVisible()) await start.click();
      await shown(page.getByRole('radio', { name: 'It halves' }));
    },
  },
  {
    name: 'notebook',
    as: 'lab-reader',
    path: () => `${topic}/notebooks`,
    load: async (page) => {
      await shown(page.getByRole('heading', { name: 'Repeated samples, in code' }));
      await shown(page.getByText('Stored output · Python 3'));
    },
  },
  {
    name: 'test attempt (code question)',
    as: 'sam',
    path: (f) => `/classes/${f.ids.classA}/topics/${f.ids.sampling}/tests`,
    load: async (page, f) => {
      const listed = page
        .getByRole('listitem')
        .filter({ hasText: f.testTitle })
        .getByRole('button', { name: 'Open' });
      const heading = page.getByRole('heading', { name: f.testTitle });
      await expect(listed.or(heading)).toBeVisible();
      if (await listed.isVisible()) await listed.click();
      await expect(heading).toBeVisible();
      await page.getByRole('button', { name: /^Start attempt|^Resume attempt/ }).click();
      await page.getByRole('button', { name: /^Question 3/ }).click();
      await shown(page.getByRole('heading', { name: 'Question 3' }));
      await shown(page.getByRole('textbox', { name: /solution\.py/ }));
    },
  },
  {
    name: 'class review with a submission',
    as: 'priya',
    path: (f) => f.reviewUrl,
    load: async (page) => {
      await shown(page.getByRole('region', { name: 'Grading workspace' }));
      const answer = page.getByText(/^Noise averages out\./);
      await shown(answer);
      // A written answer is prose: it wraps, so its box never scrolls sideways (code may).
      expect(await answer.first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
        true,
      );
    },
  },
  {
    name: 'student released results',
    as: 'sam',
    path: (f) => f.tests,
    load: async (page, f) => {
      await openTest(page, f.releasedTitle);
      await page.getByRole('button', { name: 'View feedback for attempt 1' }).click();
      await shown(page.getByRole('heading', { name: `${f.releasedTitle} · attempt 1 feedback` }));
      await shown(page.getByText('Clear reasoning about averaging out.'));
    },
  },
  {
    name: 'student receipt with an instructor request',
    as: 'sam',
    path: (f) => f.tests,
    load: async (page, f) => {
      await openTest(page, f.recoveryTitle);
      await page.getByRole('button', { name: 'Open the receipt of attempt 1' }).click();
      await shown(page.getByRole('heading', { name: 'Test submitted' }));
      await shown(page.getByText('Your instructor asked for your unsent work'));
    },
  },
  {
    name: 'student receipt with unsent work to send',
    as: 'sam',
    path: (f) => f.tests,
    load: async (page, f) => {
      // The browser kept the answers (IndexedDB, bound to the person, class and attempt).
      await keepUnsentWork(page, f);
      await openTest(page, f.recoveryTitle);
      await page.getByRole('button', { name: 'Open the receipt of attempt 2' }).click();
      await shown(page.getByRole('heading', { name: 'Test submitted' }));
      await shown(page.getByRole('button', { name: 'Send unsent work' }));
      await shown(page.getByRole('button', { name: 'Download what you wrote' }));
    },
  },
  {
    name: 'accommodations and recovery',
    as: 'priya',
    path: (f) => f.tests,
    load: async (page, f) => {
      await openTest(page, f.recoveryTitle);
      await shown(page.getByRole('region', { name: 'Extensions and extra attempts' }));
      const list = page.getByRole('list', { name: 'Closed attempts and unsent work' });
      await page.getByRole('button', { name: 'View unsent work' }).first().click();
      await shown(list.getByText('Not part of the submission.'));
      await shown(list.getByText('Unsent: a larger sample averages out noise.'));
    },
  },
  {
    name: 'release preview',
    as: 'priya',
    path: (f) => f.draftReviewUrl,
    load: async (page) => {
      await shown(page.getByRole('region', { name: 'Grading workspace' }));
      await page.getByRole('button', { name: 'Release feedback' }).click();
      await shown(page.getByRole('region', { name: 'Release preview' }));
    },
  },
  {
    name: 'bulk release preview',
    as: 'priya',
    path: (f) => f.bulkReviewUrl,
    load: async (page) => {
      await page
        .getByRole('checkbox', { name: /^Select .+ for release$/ })
        .first()
        .check();
      await page.getByRole('button', { name: /^Preview release \(\d+\)$/ }).click();
      await shown(
        page
          .getByRole('region', { name: 'Release preview' })
          .getByRole('list', { name: 'Recipients' }),
      );
    },
  },
  {
    name: 'class review with no students needing review',
    as: 'priya',
    path: (f) => f.nothingToReviewUrl,
    load: async (page) => {
      await shown(page.getByRole('heading', { name: 'No students need review.' }));
      await shown(page.getByRole('button', { name: 'Show all students' }));
    },
  },
  {
    name: 'exercise review',
    as: 'priya',
    path: (f) => f.examReviewUrl('exercises'),
    load: async (page, f) => {
      await shown(page.getByRole('heading', { name: `Exercise · ${f.exerciseTitle}` }));
      await shown(page.getByRole('list', { name: 'Steps of attempt 1' }));
    },
  },
  {
    name: 'review submissions tab',
    as: 'priya',
    path: (f) => f.examReviewUrl('submissions'),
    load: async (page) => {
      await shown(page.getByRole('tab', { name: 'Submissions', selected: true }));
      await shown(page.getByRole('heading', { name: 'Tests', level: 3 }));
      await shown(page.getByRole('region', { name: /^Test · / }));
    },
  },
  {
    name: 'review comments and questions tab',
    as: 'lab-instructor',
    path: (f) => f.commentsUrl,
    load: async (page) => {
      await shown(page.getByRole('tab', { name: 'Comments & questions', selected: true }));
      await shown(page.getByText('Why does the margin of error shrink?'));
    },
  },
  {
    name: 'course editor',
    as: 'lab-author',
    path: () => `/courses/${lab.course}/edit`,
    load: (page) => shown(page.getByRole('heading', { name: 'Publication' })),
  },
  {
    name: 'topic editor',
    as: 'lab-author',
    path: () => `/courses/${lab.course}/edit/${lab.topic}`,
    load: (page) => shown(page.getByRole('heading', { name: 'Tests', level: 3 })),
  },
];

async function open(page: Page, route: Route) {
  if (route.as) {
    const signedInAs = await page.request.post('/api/test/signin-as', {
      data: { email: route.as.includes('@') ? route.as : `${route.as}@example.test` },
    });
    expect(signedInAs.ok()).toBe(true);
  }
  await page.goto(route.path(fixtures));
  await expect(page.getByRole('main')).toBeVisible();
  await route.load(page, fixtures);
}

// Notebook outputs sit in sandboxed frames of the content origin: axe cannot enter them (they run
// no script), so they are left out here and the frame itself is checked to carry a title.
const analyse = async (page: Page) => {
  for (const frame of await page.locator('iframe').all()) {
    expect(await frame.getAttribute('title')).toBeTruthy();
  }
  return (await new AxeBuilder({ page }).exclude('iframe[sandbox]').analyze()).violations;
};

/** Elements that push the page wider than the window (empty when the page fits). */
const widePageCulprits = (page: Page) =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // Spec §14 lets only code, tables and the tab strip scroll sideways: a code block, the wrapper
    // of a table, or the tab list, and only when it really scrolls.
    const scrolls = (box: Element) => /(auto|scroll)/.test(getComputedStyle(box).overflowX);
    const isAllowedScroller = (box: Element) =>
      scrolls(box) &&
      box.scrollWidth > box.clientWidth &&
      (box.matches('pre, [role="tablist"]') || box.querySelector(':scope > table') !== null);
    const inAllowedScroller = (el: Element) => {
      for (let box: Element | null = el; box; box = box.parentElement) {
        if (isAllowedScroller(box)) return true;
      }
      return false;
    };
    const culprits = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .filter((el) => !inAllowedScroller(el))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${String(el.className)} → ${Math.round(el.getBoundingClientRect().right)} px`,
      );
    if (document.documentElement.scrollWidth > width && culprits.length === 0) {
      const beyond = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > width + 1)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${String(el.className)} → ${Math.round(el.getBoundingClientRect().right)} px`,
        );
      return [`the page scrolls: ${document.documentElement.scrollWidth} px wide`, ...beyond];
    }
    return culprits;
  });

/**
 * 200% text zoom for a UI sized in px: every element's font size is doubled, as a browser's text
 * zoom would. Returns the first heading's height before and after, so a test can show it applied.
 */
async function zoomText(page: Page): Promise<{ before: number; after: number }> {
  return page.evaluate(() => {
    const heading = document.querySelector('h1') ?? document.body;
    const before = heading.getBoundingClientRect().height;
    const sizes = [...document.body.querySelectorAll('*')].map(
      (el) => [el as HTMLElement, Number.parseFloat(getComputedStyle(el).fontSize)] as const,
    );
    for (const [el, size] of sizes) el.style.setProperty('font-size', `${size * 2}px`, 'important');
    return { before, after: heading.getBoundingClientRect().height };
  });
}

for (const route of routes) {
  test.describe(`${route.name} in the dark palette`, () => {
    test.use({ colorScheme: 'dark' });

    test(`A19 axe finds no violations on ${route.name} in the dark palette`, async ({ page }) => {
      await open(page, route);
      expect(await analyse(page)).toEqual([]);
    });
  });

  test(`A19 axe finds no violations on ${route.name}`, async ({ page }) => {
    await open(page, route);
    expect(await analyse(page)).toEqual([]);
  });

  test.describe(`${route.name} at 320 px`, () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test(`A19 ${route.name} at 320 px keeps horizontal scroll to code, tables and the tab strip`, async ({
      page,
    }) => {
      await open(page, route);
      expect(await widePageCulprits(page)).toEqual([]);
    });

    test(`A19 ${route.name} at 320 px and 200% text keeps horizontal scroll to code, tables and the tab strip`, async ({
      page,
    }) => {
      await open(page, route);
      const { before, after } = await zoomText(page);
      // The zoom took effect: a heading's text is larger (a no-op would leave it unchanged).
      expect(after).toBeGreaterThan(before * 1.5);
      await expect(page.getByRole('main')).toBeVisible();
      expect(await widePageCulprits(page)).toEqual([]);
      expect(await analyse(page)).toEqual([]);
    });
  });
}

/** The Phase 4 screens a person uses by touch: every button, link, select and text box is at least 44 px. */
const touched = [
  'student released results',
  'student receipt with an instructor request',
  'student receipt with unsent work to send',
  'accommodations and recovery',
  'release preview',
  'bulk release preview',
  'class review with no students needing review',
];

test.describe('coarse pointer', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const route of routes.filter((r) => touched.includes(r.name))) {
    test(`A20 ${route.name} controls are at least 44 px with a touch screen`, async ({ page }) => {
      await open(page, route);
      expect(await page.locator('main button').count()).toBeGreaterThan(0);
      expect(
        await small(
          page,
          'main button, main select, main textarea, main a, main input:not([type="checkbox"], [type="radio"])',
        ),
      ).toEqual([]);
    });
  }
});
