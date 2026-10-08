import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTests, idsInGoTests, idsInTsTitles, readDone } from './check-scenarios.js';

describe('scenario scanner', () => {
  it('AUD8 counts IDs in test, it and describe titles', () => {
    const src = `
      describe('A01 shell', () => {
        it("A02 second", () => {});
        test.concurrent(\`A03 third\`, () => {});
        test.each([1, 2])('A04 case %s', () => {});
      });`;
    expect(idsInTsTitles(src)).toEqual(['A01', 'A02', 'A03', 'A04']);
  });

  it('AUD8 ignores IDs in comments and strings outside titles', () => {
    const src = `
      // A05 later
      /* A06 block
         A07 more */
      const label = 'A08 not a title';
      test('unrelated title', () => { expect('A09').toBe('A09'); });`;
    expect(idsInTsTitles(src)).toEqual([]);
  });

  it('AUD8 ignores method calls named test and test calls inside strings', () => {
    const src = `
      expect(/A01/.test('A01 x')).toBe(true);
      const fixture = "it('A02 quoted', () => {})";
      obj.it('A03 method', () => {});`;
    expect(idsInTsTitles(src)).toEqual([]);
  });

  it('AUD8 ignores a skipped block together with its children', () => {
    const src =
      "describe.skip('A12 group', () => { it('A13 inside', () => {}); });\nit('A14 kept', () => {});";
    expect(idsInTsTitles(src)).toEqual(['A14']);
  });

  it('AUD8 a title-only todo does not swallow the next test', () => {
    const src = "test.todo('A11 todo');\nit('A15 kept', () => {});\nit('A16 kept', () => {});";
    expect(idsInTsTitles(src)).toEqual(['A15', 'A16']);
    expect(idsInTsTitles("it.skip('A11 off');\nit('A15 kept', () => {});")).toEqual(['A15']);
  });

  it('AUD8 ignores unrelated skipIf blocks but not other tests after them', () => {
    const src = `
      describe.skipIf(process.platform === 'win32')('A14 platform', () => { it('A17 child', () => {}); });
      it('A15 kept', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A15']);
  });

  it('AUD8 handles nested parentheses in modifier arguments', () => {
    const src = `
      it.each([{ a: f(1) }])('A15 each', () => {});
      test.each(Object.keys(cases))('A05 keys', () => {});
      describe.skipIf(!(await imagePresent()))('A13 docker', () => {});
      describe.skipIf(!(await other()))('A14 other', () => { it('A18 child', () => {}); });`;
    expect(idsInTsTitles(src)).toEqual(['A15', 'A05', 'A13']);
  });

  it('AUD8 a skipped block with JSX is skipped alone', () => {
    const src = "it.skip('x', () => { render(<p>a</p>); });\nit('A01 kept', () => {});";
    expect(idsInTsTitles(src)).toEqual(['A01']);
  });

  it('AUD8 regex literals, apostrophes and templates do not hide later tests', () => {
    const src = `
      expect(s).toMatch(/['"]/);
      const u = 'http://h';
      function f(s) { return /\`/.test(s) }
      const t = <p>Don't</p>;
      it('A02 z', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A02']);
  });

  it('AUD8 tagged-template tables and test.extend fixtures count, test.step does not', () => {
    const src = `
      const myTest = test.extend({});
      test.each\`
        a | b
      \`('A03 tagged $a', () => {});
      myTest('A06 fixture', () => {});
      it('A07 outer', async () => { await test.step('A08 step', () => {}); });`;
    expect(idsInTsTitles(src)).toEqual(['A03', 'A06', 'A07']);
  });

  it('AUD8 reads the fixed text of templates with substitutions', () => {
    const src = 'test(`A04 cards at $' + '{width} px use $' + '{cards} column(s)`, () => {});';
    expect(idsInTsTitles(src)).toEqual(['A04']);
  });

  it('AUD8 keeps the documented Docker, S3 and CI gates only', () => {
    const src = `
      describe.skipIf(!imagePresent)('A13 sandbox', () => {});
      test.runIf(env.CI)('A22 CI gate', () => {});
      describe.skipIf(!env.S3_ENDPOINT)('A22 s3', () => {});
      test.skipIf(process.env.CI)('A04 never in CI', () => {});
      test.skipIf(!env.CI)('A09 only in CI', () => {});
      test.runIf(!env.CI)('A10 only outside CI', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A13', 'A22', 'A22', 'A09']);
    expect(idsInTsTitles(`describe.skipIf(!ok)('A20 x', () => {});`, 'a.docker.itest.ts')).toEqual([
      'A20',
    ]);
  });

  it('AUD8 matches Go test function names', () => {
    const src = `
// func TestA27_Commented(t *testing.T) {}
func TestA28_OwnedSessionReady(t *testing.T) {}
func TestA30_ChangedKey(t *testing.T) {}
func TestA290_NotAnID(t *testing.T) {}
func TestHelperA31(t *testing.T) {}
func helperA32() {}
/* func TestA33_InBlock(t *testing.T) {}
*/
var p = \`C:\\\`
func TestA34_AfterRawString(t *testing.T) 
`;
    expect(idsInGoTests(src)).toEqual(['A28', 'A30', 'A34']);
  });

  it('AUD8b gates are matched on the condition AST, not on words in it', () => {
    const src = `
      test.skipIf(!fast || process.env.CI)('A05 mixed condition', () => {});
      test.skipIf(!env.CI && other)('A06 and-condition', () => {});
      test.runIf(env.CI || fast)('A07 or-condition', () => {});
      test.skipIf(!imagePresent)('A13 image', () => {});
      test.skipIf(!(await dockerAvailable()))('A14 docker', () => {});
      test.skipIf(!process.env.S3_ENDPOINT)('A22 s3', () => {});
      test.runIf(process.env.CI)('A09 ci', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A13', 'A14', 'A22', 'A09']);
  });

  it('AUD8b a /* inside a Go string does not blank the tests after it', () => {
    const src = `
var dir = "/tmp/*"
var raw = \`/* not a comment\`
func TestA28_AfterString(t *testing.T) {}
func TestA30_AfterRune(t *testing.T) { _ = '"' }
func TestA31_AfterEscape(t *testing.T) { _ = "q\\"/*" }
// closes later */
/* real comment
func TestA33_Commented(t *testing.T) {}
*/
func TestA34_AfterComment(t *testing.T) {}
`;
    expect(idsInGoTests(src)).toEqual(['A28', 'A30', 'A31', 'A34']);
  });

  it('AUD8b an unconditional test.skip or test.fixme in a group skips its titles', () => {
    const src = `
      test.describe('A05 whole group', () => {
        test.skip();
        test('A06 inside', async () => {});
      });
      test.describe('A07 fixme group', () => {
        test.fixme(true, 'broken');
        test('A08 inside', async () => {});
      });
      test.describe('A09 conditional stays', () => {
        test.skip(browserName === 'webkit', 'no webkit');
        test('A10 inside', async () => {});
      });
      test.describe('A11 one test', () => {
        test('A12 skipped alone', async () => { test.skip(); });
        test('A13 kept', async () => {});
      });`;
    expect(idsInTsTitles(src)).toEqual(['A09', 'A10', 'A11', 'A13']);
    expect(idsInTsTitles("test.skip();\ntest('A01 file skipped', () => {});")).toEqual([]);
  });

  it('AUD8b chained and imported test.extend fixtures count', () => {
    const files: Record<string, string> = {
      'e2e/fixtures.ts': `
        import { test as base } from '@playwright/test';
        export const authed = base.extend({}).extend({});
        export const typed = base.extend<{ a: number }>({ a: 1 });
        export { authed as signedIn };`,
      'e2e/reexport.ts': "export { authed as viaReexport } from './fixtures.js';",
      'e2e/tests/a01.e2e.ts': `
        import { authed, signedIn as second } from '../fixtures.js';
        import { viaReexport } from '../reexport.js';
        import { typed } from '../fixtures.js';
        import { t3 } from '../playwright-reexport.js';
        import { authed as starred } from '../star.js';
        import { other } from '../elsewhere.js';
        const local = test.extend({}).extend({});
        authed('A01 imported', async () => {});
        second('A02 renamed', async () => {});
        viaReexport('A03 re-exported', async () => {});
        local('A04 chained', async () => {});
        other('A05 unknown module', async () => {});
        typed('A06 typed', async () => {});
        t3('A07 playwright re-export', async () => {});
        starred('A08 export star', async () => {});`,
      'e2e/playwright-reexport.ts': "export { test as t3, expect } from '@playwright/test';",
      'e2e/star.ts': "export * from './fixtures.js';",
    };
    const found = findTests(Object.keys(files), (f) => files[f] ?? '');
    expect([...found.keys()].sort()).toEqual(['A01', 'A02', 'A03', 'A04', 'A06', 'A07', 'A08']);
  });

  it('AUD8b a skip in a beforeEach hook skips the group', () => {
    const src = `
      test.describe('A05 hooked', () => {
        test.beforeEach(() => { test.skip(); });
        test('A06 inside', async () => {});
      });
      test.describe('A07 conditional hook', () => {
        test.beforeEach(({ browserName }) => { test.skip(browserName === 'x'); });
        test('A08 inside', async () => {});
      });`;
    expect(idsInTsTitles(src)).toEqual(['A07', 'A08']);
  });

  it('AUD8b import cycles between fixture modules still resolve', () => {
    const files: Record<string, string> = {
      'e2e/a.ts': "import { b } from './b.js'; export const a = test.extend({}); export { b };",
      'e2e/b.ts': "import { a } from './a.js'; export const b = test.extend({}); export { a };",
      'e2e/x.e2e.ts': "import { a, b } from './b.js'; a('A01 a', () => {}); b('A02 b', () => {});",
    };
    const found = findTests(Object.keys(files), (f) => files[f] ?? '');
    expect([...found.keys()].sort()).toEqual(['A01', 'A02']);
  });

  it('AUD8b reads the literal parts of titles joined with +', () => {
    const src = `
      it('A05 ' + name, () => {});
      it(prefix + ' A06 ' + name, () => {});
      it(('A07' + ' x'), () => {});
      it('A0' + n, () => {});
      it(prefix + name, () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A05', 'A06', 'A07']);
  });

  it('AUD8 maps IDs to files across TS and Go', () => {
    const files: Record<string, string> = {
      'a/x.test.ts': "it('A01 one', () => {});",
      'connector/y_test.go': 'func TestA28_Y(t *testing.T) {}',
      'a/z.test.ts': '// A01 only here',
    };
    const found = findTests(Object.keys(files), (f) => files[f] ?? '');
    expect([...found.keys()].sort()).toEqual(['A01', 'A28']);
    expect([...(found.get('A01') ?? [])]).toEqual(['a/x.test.ts']);
  });

  it('AUD8 keeps every done file listing an ID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'done-'));
    writeFileSync(join(dir, 'P1-01.txt'), 'A01\nA02\n');
    writeFileSync(join(dir, 'P1-02.txt'), 'A01\n');
    const done = readDone(dir);
    expect(done.get('A01')).toEqual(['P1-01.txt', 'P1-02.txt']);
    expect(done.get('A02')).toEqual(['P1-01.txt']);
  });
});
