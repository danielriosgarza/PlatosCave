/**
 * Reads a typed number in the common forms: `1000.5`, `1,000.5`, `1.000,5`, `1000,5`, `1 000`.
 * The last of `.` and `,` is the decimal mark when both appear; a lone separator followed by
 * exactly three digits in every group is grouping (`1,000`, `1.000.000`), otherwise a lone
 * comma is a decimal comma. Returns null for anything else. The browser reads a numeric step's
 * field with it, and the server reads a typed gap of a fill-in step with it.
 */
export function parseNumber(text: string): number | null {
  let s = text
    .trim()
    .replace(/−/g, '-')
    .replace(/(?<=\d)[\s  ](?=\d{3}(?!\d))/g, '');
  // Grouped integers: one to three digits not starting with 0, then groups of exactly three.
  const grouped = (int: string, mark: string) =>
    new RegExp(`^[+-]?[1-9]\\d{0,2}(\\${mark}\\d{3})+$`).test(int);
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot !== -1 && comma !== -1) {
    const [decimal, group] = dot > comma ? ['.', ','] : [',', '.'];
    const at = s.lastIndexOf(decimal);
    const int = s.slice(0, at);
    if (!grouped(int, group)) return null;
    s = int.split(group).join('') + '.' + s.slice(at + 1);
  } else if (comma !== -1) {
    s = grouped(s, ',') ? s.replaceAll(',', '') : s.replace(',', '.');
  } else if (grouped(s, '.') && s.split('.').length > 2) {
    s = s.replaceAll('.', '');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
