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

  it('AUD8 regex literals and apostrophes do not confuse strings and comments', () => {
    const src = `
      expect(s).toMatch(/['"]/);
      const u = 'http://h';
      const t = <p>Don't</p>;
      it('A02 z', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A02']);
  });

  it('AUD8 keeps the documented Docker and S3 skips', () => {
    const src = `
      describe.skipIf(!imagePresent)('A13 sandbox', () => {});
      test.runIf(env.CI)('A22 CI gate', () => {});
      describe.skipIf(!env.S3_ENDPOINT)('A22 s3', () => {});`;
    expect(idsInTsTitles(src)).toEqual(['A13', 'A22', 'A22']);
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
`;
    expect(idsInGoTests(src)).toEqual(['A28', 'A30']);
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
