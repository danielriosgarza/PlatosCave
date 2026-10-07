import type { Strokes } from './anchors';

/**
 * Drawings are stored in coordinates normalised to their figure or page (§8), so a stroke's
 * width needs a reference too: it is in pixels of a surface this wide, and scales with the
 * surface it is drawn on or exported to.
 */
export const SKETCH_REFERENCE_WIDTH = 900;

// XML 1.0 forbids C0 controls other than tab, LF and CR, and the non-characters U+FFFE and U+FFFF,
// even as character references; drop them so the document stays well-formed.
const xmlLegal = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 0x20 ? code < 0xfffe : code === 0x9 || code === 0xa || code === 0xd;
};
const escapeXml = (s: string) =>
  [...s]
    .filter(xmlLegal)
    .join('')
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A drawing as a standalone SVG document for annotation export (§8 "readable drawings"). `aspect`
 * is the surface's height over its width. Erasers remove what was drawn before them, as on the
 * canvas, through masks; the description is the document's accessible text.
 */
export function strokesToSvg(
  strokes: Strokes,
  options: { aspect: number; title?: string; description?: string },
): string {
  const width = SKETCH_REFERENCE_WIDTH;
  const height = round(width * options.aspect);
  let defs = '';
  let body = '';
  let erasers = 0;
  for (const stroke of strokes) {
    const points = stroke.points.map(([x, y]) => `${round(x * width)},${round(y * height)}`);
    if (stroke.tool === 'pen') {
      const [first] = points;
      body +=
        points.length === 1 && first
          ? `<circle cx="${first.split(',')[0]}" cy="${first.split(',')[1]}" r="${round(stroke.width / 2)}" fill="${stroke.color}"/>`
          : `<polyline points="${points.join(' ')}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
      continue;
    }
    const id = `erase-${++erasers}`;
    const cut =
      points.length === 1
        ? `<circle cx="${(points[0] ?? '0,0').split(',')[0]}" cy="${(points[0] ?? '0,0').split(',')[1]}" r="${round(stroke.width / 2)}" fill="#000"/>`
        : `<polyline points="${points.join(' ')}" fill="none" stroke="#000" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#fff"/>${cut}</mask>`;
    body = `<g mask="url(#${id})">${body}</g>`;
  }
  const title = options.title ? `<title>${escapeXml(options.title)}</title>` : '';
  const desc = options.description ? `<desc>${escapeXml(options.description)}</desc>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `${title}${desc}${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`
  );
}
