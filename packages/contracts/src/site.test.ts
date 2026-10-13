import { describe, expect, test } from 'vitest';
import type { SiteConfigInput } from './site';
import { instructorMeta, siteCatalogue, siteConfig, siteIssueLines } from './site';

const runtime = {
  id: 'python-3.12',
  language: 'python',
  image: 'registry.example.org/parallax-runner-python',
  digest: `sha256:${'a'.repeat(64)}`,
  harnessVersion: '4',
  packages: ['numpy'],
};
const runner = { host: '10.0.0.7', databaseHost: '10.0.0.2', runtimes: [runtime] };
const instructor = {
  mode: 'instructor',
  name: 'Statistics for Biologists',
  logo: { file: 'src/logo.png', alt: 'Statistics for Biologists' },
  level: 1,
  origins: { app: 'https://stats.example.org', content: 'https://content.stats.example.org' },
  signIn: { email: { from: 'Statistics <login@example.org>' } },
  classes: [
    { course: 'statistics', name: 'Spring 2027' },
    { course: 'statistics', name: 'Open course', open: true },
  ],
} satisfies SiteConfigInput;
const school = {
  ...instructor,
  mode: 'school',
  instructors: ['ana', 'ben'],
  classes: [
    { course: 'ana/statistics', name: 'Spring 2027', instructors: ['ana', 'ben'] },
    { course: 'ben/genetics', name: 'Spring 2027' },
  ],
} satisfies SiteConfigInput;

const one = (patch: object) => ({ ...instructor, ...patch });
const many = (patch: object) => ({ ...school, ...patch });
const origins = (patch: object) => one({ origins: { ...instructor.origins, ...patch } });
const runtimes = (...list: object[]) => one({ runner: { ...runner, runtimes: list } });
const spring = (base: object, cls: object) => ({ ...base, classes: [{ name: 'Spring', ...cls }] });
function lines(config: unknown): string[] {
  const parsed = siteConfig.safeParse(config);
  return parsed.success ? [] : siteIssueLines(parsed.error.issues);
}

describe('siteConfig', () => {
  test('a configuration of each mode and level parses', () => {
    for (const config of [instructor, school]) {
      for (const level of [0, 1, 2]) {
        expect(lines({ ...config, level, runner }), `${config.mode} ${level}`).toEqual([]);
      }
      // Sign-in is unused at level 0, and the runner below level 2.
      expect(lines({ ...config, level: 0, signIn: undefined })).toEqual([]);
      expect(lines(config)).toEqual([]);
    }
    // http is accepted on a loopback host, where the development pair of hosts differs.
    const local = origins({ app: 'http://localhost:5173', content: 'http://127.0.0.1:3000' });
    expect(lines(local)).toEqual([]);
  });

  test('open is false when omitted, and the other defaults are filled in', () => {
    const parsed = siteConfig.parse(origins({ app: 'https://Stats.Example.org/' }));
    expect(parsed.classes.map((cls) => cls.open)).toEqual([false, true]);
    expect(parsed.instructors).toEqual(['.']);
    expect(parsed.classes.map((cls) => cls.instructors)).toEqual([['.'], ['.']]);
    expect(parsed.origins).toEqual({ ...instructor.origins, shiny: [] });
    // A class that names no instructor gets the folder that holds its course.
    const inSchool = siteConfig.parse(school).classes.map((cls) => cls.instructors);
    expect(inSchool).toEqual([['ana', 'ben'], ['ben']]);
    expect(siteConfig.parse(one({ classes: undefined })).classes).toEqual([]);
  });

  test('a refused configuration names the field, one line for each problem', () => {
    const cls = { course: 'statistics', instructors: ['ana'] };
    const both = spring(origins({ content: 'https://stats.example.org:8443' }), cls);
    expect(lines(both)).toEqual([
      'origins.content: must not have the host name of origins.app, stats.example.org',
      'classes[0].instructors[0]: ana is not in instructors',
    ]);
    const refused: [string, unknown][] = [
      ['theme', one({ theme: 'dark' })],
      ['classes[0].code', spring(instructor, { course: 'statistics', code: 'x' })],
      ['instructors[0]', many({ instructors: ['ana@example.org'], classes: [] })],
      ['logo.alt', one({ logo: { file: 'src/logo.png' } })],
      ['logo.file', one({ logo: { file: 'src/logo.svg', alt: 'Logo' } })],
      ['runner', one({ level: 2 })],
      ['runner.runtimes[0].digest', runtimes({ ...runtime, digest: undefined })],
      ['runner.runtimes[0].digest', runtimes({ ...runtime, digest: null })],
      ['runner.runtimes', runtimes(runtime, runtime)],
      ['runner.host', one({ runner: { ...runner, host: 'runner.example.org' } })],
      ['classes[0].instructors[0]', spring(school, { course: 'ana/x', instructors: ['carl'] })],
      ['classes[0].course', spring(school, { course: 'carl/genetics' })],
      ['classes[0].course', spring(school, { course: 'genetics' })],
      ['classes[0].course', spring(instructor, { course: 'ana/statistics' })],
      ['classes[0].course', spring(instructor, { course: '..' })],
      ['classes[1].name', one({ classes: [instructor.classes[0], instructor.classes[0]] })],
      ['instructors', many({ instructors: undefined, classes: [] })],
      ['instructors[2]', many({ instructors: ['ana', 'ben', 'ana'] })],
      ['instructors', one({ instructors: ['ana'], classes: [] })],
      ['origins.app', origins({ app: 'http://stats.example.org' })],
      ['origins.content', origins({ content: 'https://content.stats.example.org/files' })],
      ['origins.content', origins({ app: 'http://localhost:1', content: 'http://localhost:2' })],
      ['origins.shiny[0]', origins({ shiny: ['https://stats.example.org:3838'] })],
      ['origins.shiny[0]', origins({ shiny: [instructor.origins.content] })],
      ['origins.shiny[1]', origins({ shiny: ['https://r.example.org', instructor.origins.app] })],
      ['signIn', one({ signIn: {} })],
      ['level', one({ level: 3 })],
      ['mode', one({ mode: undefined })],
      ['name', one({ name: 'Statistics\u0007' })],
      ['name', one({ name: 'x'.repeat(81) })],
    ];
    for (const [field, config] of refused) {
      // Each line starts with the field it names.
      const named = lines(config).map((line) => line.slice(0, line.indexOf(': ')));
      expect(named, JSON.stringify(config)).toEqual([field]);
    }
  });
});

test('instructor.yaml and the catalogue take no field beyond their own', () => {
  const meta = { name: 'Ana Example', email: 'ana@example.org' };
  expect(instructorMeta.parse(meta)).toEqual(meta);
  const metas = [{ ...meta, role: 'admin' }, { name: meta.name }, { ...meta, email: 'ana' }];
  for (const bad of metas)
    expect(instructorMeta.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  // The catalogue has names and titles: no field for an address, a class or material.
  const course = { slug: 'statistics', title: 'Statistics for Biologists' };
  const ana = { slug: 'ana', name: 'Ana Example', courses: [course] };
  expect(siteCatalogue.parse({ instructors: [ana] })).toEqual({ instructors: [ana] });
  const catalogues = [
    { instructors: [{ ...ana, email: meta.email }] },
    { instructors: [{ ...ana, courses: [{ ...course, topics: [] }] }] },
    { instructors: [ana], classes: [] },
  ];
  for (const bad of catalogues)
    expect(siteCatalogue.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});
