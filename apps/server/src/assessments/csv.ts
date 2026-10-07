/**
 * CSV for spreadsheet programs (§12). Text that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return would be read as a formula; it is prefixed with an apostrophe so it displays
 * as typed and never runs. Applied to every text cell, whoever wrote it.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvCell = string | number | null;

export function csvCell(value: CsvCell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Header and rows, CRLF-separated and CRLF-terminated (RFC 4180). */
export function toCsv(header: readonly string[], rows: readonly CsvCell[][]): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
