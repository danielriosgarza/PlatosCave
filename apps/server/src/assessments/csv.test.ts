import { describe, expect, test } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('CSV cells', () => {
  test('A21 text that a spreadsheet would run as a formula is prefixed so it reads as typed', () => {
    for (const text of [
      '=1+1',
      '+SUM(A1)',
      '-2+3',
      '@cmd',
      '\tx',
      '\rx',
      '=HYPERLINK("http://x")',
    ]) {
      expect(csvCell(text).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  test('A21 ordinary text and numbers are unchanged', () => {
    expect(csvCell('Priya Nair')).toBe('Priya Nair');
    expect(csvCell('Ünïcode – ok')).toBe('Ünïcode – ok');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
  });

  test('A21 commas, quotes and line breaks are quoted', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  test('A21 rows end in CRLF', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x', 1],
          [null, '=y'],
        ],
      ),
    ).toBe("a,b\r\nx,1\r\n,'=y\r\n");
  });
});
