import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { releaseToClassA, signedIn, type WorldIds, worldIds } from './released';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { course: id(111), class: id(211), topic: id(311), nativeRevision: id(511) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

const exercise = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'What happens to the standard error when n goes from 25 to 100?',
      options: [
        { id: 'half', label: 'It halves' },
        { id: 'same', label: 'It stays the same' },
      ],
      correct: 'half',
      feedback: { correct: 'Yes, the standard error halves.', incorrect: 'Not quite.' },
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

const testDefinition = {
  schema: 'test.v1',
  settings: { attempts: 3, timeZone: 'Europe/Madrid' },
  questions: [
    {
      id: 'spread',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 2,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
      correct: ['n100'],
    },
    {
      id: 'why',
      kind: 'explanation',
      prompt: 'Why does the larger sample vary less?',
      points: 3,
      rubric: [{ id: 'averaging', label: 'Names averaging out of noise', points: 3 }],
    },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
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

interface Fixtures {
  ids: WorldIds;
  exerciseTitle: string;
  testTitle: string;
  reviewUrl: string;
}
let fixtures: Fixtures;

test.beforeAll(async ({ playwright, baseURL }) => {
  const ids = await worldIds(playwright, baseURL);
  const stamp = `${Date.now()}-${test.info().workerIndex}`;
  const exerciseTitle = `Routes exercise ${stamp}`;
  const testTitle = `Routes test ${stamp}`;
  const submittedTitle = `Routes submitted ${stamp}`;
  await releaseToClassA(playwright, baseURL, ids, 'exercise', exerciseTitle, exercise);
  await releaseToClassA(playwright, baseURL, ids, 'test', testTitle, testDefinition);
  const submittedId = await releaseToClassA(
    playwright,
    baseURL,
    ids,
    'test',
    submittedTitle,
    testDefinition,
  );
  // Sam submits a test, so the class review has a submission to show.
  const sam = await signedIn(playwright, baseURL, 'sam@example.test');
  const url = `/api/classes/${ids.classA}/resources/${submittedId}/test-attempts`;
  const started = await sam.post(url);
  expect(started.ok()).toBe(true);
  const attemptId = ((await started.json()) as { id: string }).id;
  const attempt = `/api/classes/${ids.classA}/test-attempts/${attemptId}`;
  for (const [question, value] of [
    ['spread', ['n100']],
    ['why', 'Noise averages out.'],
    [
      'mean',
      {
        files: [{ path: 'solution.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }],
      },
    ],
  ] as const) {
    expect(
      (await sam.put(`${attempt}/answers/${question}`, { data: { value, seq: 1 } })).ok(),
    ).toBe(true);
  }
  expect(
    (await sam.post(`${attempt}/submit`, { data: { submissionKey: `routes-${Date.now()}` } })).ok(),
  ).toBe(true);
  await sam.dispose();
  fixtures = {
    ids,
    exerciseTitle,
    testTitle,
    reviewUrl: `/classes/${ids.classA}/review?assignment=${submittedId}&selected=${ids.sam}&attempt=${attemptId}`,
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
      await shown(page.getByText('Noise averages out.'));
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
