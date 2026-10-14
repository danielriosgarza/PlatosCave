import { describe, expect, it } from 'vitest';
import { isPageAddress, normalise, pageAddress, screenAt } from './sitePages';

describe('pageAddress', () => {
  it('gives a file under src/pages its address', () => {
    expect(pageAddress('index.tsx')).toBe('/');
    expect(pageAddress('about.tsx')).toBe('/about');
    expect(pageAddress('team/index.tsx')).toBe('/team');
    expect(pageAddress('team/open-days-2027.jsx')).toBe('/team/open-days-2027');
    expect(pageAddress('team\\index.tsx')).toBe('/team');
  });

  it('leaves out helpers and files that are not pages', () => {
    expect(pageAddress('_layout.tsx')).toBeNull();
    expect(pageAddress('team/_card.tsx')).toBeNull();
    expect(pageAddress('_parts/card.tsx')).toBeNull();
    expect(pageAddress('about.module.css')).toBeNull();
    expect(pageAddress('data.ts')).toBeNull();
    expect(pageAddress('notes.mdx')).toBeNull();
  });

  it('refuses a segment other than lower-case letters, digits and hyphens, naming the file', () => {
    for (const file of ['About.tsx', 'team/$id.tsx', 'my page.tsx', 'Team/index.tsx', '.tsx']) {
      expect(() => pageAddress(file)).toThrow(file);
    }
  });
});

describe('isPageAddress', () => {
  it('accepts / and segments of lower-case letters, digits and hyphens only', () => {
    for (const address of ['/', '/about', '/team/open-days-2027']) {
      expect(isPageAddress(address)).toBe(true);
    }
    for (const address of ['', 'about', '/About', '/about/', '//about', '/team/$id', '/a%62']) {
      expect(isPageAddress(address)).toBe(false);
    }
  });
});

describe('normalise', () => {
  it('decodes percent-escapes, lower-cases and drops a trailing slash', () => {
    expect(normalise('/courses/')).toBe('/courses');
    expect(normalise('/%63ourses')).toBe('/courses');
    expect(normalise('/%43OURSES')).toBe('/courses');
    expect(normalise('//courses//')).toBe('/courses');
    expect(normalise('/')).toBe('/');
    expect(normalise('')).toBe('/');
    expect(normalise('/a%zz/%E2%82%AC')).toBe('/a%zz/€');
  });
});

describe('screenAt', () => {
  const screens = [
    '/',
    '/signin',
    '/courses',
    '/classes/$classId/review',
    '/classes/$classId/topics',
  ];

  it('finds the screen whose address a page would take, a parameter matching any one segment', () => {
    expect(screenAt('/courses', screens)).toBe('/courses');
    expect(screenAt('/courses/', screens)).toBe('/courses');
    expect(screenAt('/%63ourses', screens)).toBe('/courses');
    expect(screenAt('/SignIn', screens)).toBe('/signin');
    expect(screenAt('/classes/demo/review', screens)).toBe('/classes/$classId/review');
    expect(screenAt('/', screens)).toBe('/');
  });

  it('finds none for an address that no screen has', () => {
    expect(screenAt('/about', screens)).toBeUndefined();
    expect(screenAt('/classes/demo', screens)).toBeUndefined();
    expect(screenAt('/classes/demo/review/notes', screens)).toBeUndefined();
    expect(screenAt('/courses-old', screens)).toBeUndefined();
  });

  it('throws for a screen address with a kind of parameter it cannot compare', () => {
    for (const pattern of ['/docs/$', '/{-$lang}/courses', '/files/doc-{$id}']) {
      expect(() => screenAt('/about', [...screens, pattern])).toThrow(pattern);
    }
  });
});
