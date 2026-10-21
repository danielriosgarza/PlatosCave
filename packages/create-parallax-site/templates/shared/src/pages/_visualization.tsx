import { useLayoutEffect, useRef, useState } from 'react';
import styles from './_visualization.module.css';

// The picture of the front page: the five Platonic solids above a shelf, each tumbling slowly
// about axes of its own. It is drawn here in the page's ink alone, shaded with an ordered dither, so
// the file needs no image. A name that starts with `_` makes this file a helper of `index.tsx`
// and not a page. To change the picture, edit the constants below; to replace it, export another
// component from this file; to remove it, delete its import and its element in `index.tsx`.

/** The height of the drawing in scene pixels. Its width is whatever its box holds. */
const HEIGHT = 76;
/** CSS pixels per scene pixel: a whole number, so that every pixel is crisp. */
const pixelFor = (cssWidth: number) => (cssWidth >= 1500 ? 4 : cssWidth >= 600 ? 3 : 2);
/** The row of the shelf, and the widest the row of solids grows, in scene pixels. */
const SHELF = 66;
const ROW = 260;
/** Each solid turns about two axes at once, at these turns per minute; the axes come from
 * `SEED`, so a different seed tumbles them differently. */
const SPIN = [4, 1.3];
const SEED = 7;
/** The direction of the light: from the upper left, in front. */
const LIGHT = normalise([-0.55, 0.65, 0.55]);
/** Frames per second: low on purpose. */
const FPS = 24;

type Vector = [number, number, number];
type Matrix = [Vector, Vector, Vector];
type Face = { normal: Vector; corners: number[] };
type Solid = { vertices: Vector[]; faces: Face[]; size: number };

function normalise([x, y, z]: Vector): Vector {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const apply = (m: Matrix, v: Vector): Vector => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const column = (m: Matrix, j: 0 | 1 | 2): Vector => [m[0][j], m[1][j], m[2][j]];
const multiply = (a: Matrix, b: Matrix): Matrix => {
  const [x, y, z] = [column(b, 0), column(b, 1), column(b, 2)];
  return [apply([x, y, z], a[0]), apply([x, y, z], a[1]), apply([x, y, z], a[2])];
};
/** The rotation by `angle` about the unit vector `axis`. */
function about([x, y, z]: Vector, angle: number): Matrix {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
/** A number in [0, 1) that depends only on its arguments. */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(SEED, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** An axis and a direction of turning for each solid, picked by the seed. */
const AXES = [0, 1, 2, 3, 4].map((n) =>
  [0, 1].map((k) => {
    const z = hash(n, k * 3) * 2 - 1;
    const angle = hash(n, k * 3 + 1) * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    const sign = hash(n, k * 3 + 2) < 0.5 ? -1 : 1;
    return { axis: [r * Math.cos(angle), r * Math.sin(angle), z] as Vector, sign };
  }),
);

/** The corners of each solid, from its usual coordinates. */
const PHI = (1 + Math.sqrt(5)) / 2;
const SIGNS = [-1, 1];
const CORNERS: Vector[][] = [
  [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ],
  SIGNS.flatMap((a) => SIGNS.flatMap((b) => SIGNS.map((c): Vector => [a, b, c]))),
  [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  [
    ...SIGNS.flatMap((a) => SIGNS.flatMap((b) => SIGNS.map((c): Vector => [a, b, c]))),
    ...SIGNS.flatMap((a) =>
      SIGNS.flatMap((b): Vector[] => [
        [0, a / PHI, b * PHI],
        [a / PHI, b * PHI, 0],
        [a * PHI, 0, b / PHI],
      ]),
    ),
  ],
  SIGNS.flatMap((a) =>
    SIGNS.flatMap((b): Vector[] => [
      [0, a, b * PHI],
      [a, b * PHI, 0],
      [b * PHI, 0, a],
    ]),
  ),
];
/** The size of each solid, so that they look alike in weight. */
const SIZES = [26, 26, 26, 27, 27];

/** A solid scaled into the unit sphere, with its faces. */
function build(points: Vector[], size: number): Solid {
  const radius = Math.max(...points.map((p) => Math.hypot(...p)));
  const vertices = points.map((p) => p.map((n) => n / radius) as Vector);
  const faces: Face[] = [];
  // Every plane through three corners with all the others on one side is a face.
  for (let i = 0; i < vertices.length; i++)
    for (let j = i + 1; j < vertices.length; j++)
      for (let k = j + 1; k < vertices.length; k++) {
        const [a, b, c] = [vertices[i], vertices[j], vertices[k]] as [Vector, Vector, Vector];
        const raw = cross(minus(b, a), minus(c, a));
        if (Math.hypot(...raw) < 1e-9) continue;
        let normal = normalise(raw);
        const sides = vertices.map((v) => dot(minus(v, a), normal));
        if (Math.min(...sides) >= -1e-9) normal = normal.map((n) => -n) as Vector;
        else if (Math.max(...sides) > 1e-9) continue;
        if (faces.some((f) => dot(f.normal, normal) > 1 - 1e-6)) continue;
        const offset = dot(a, normal);
        faces.push({
          normal,
          corners: vertices.flatMap((v, n) =>
            Math.abs(dot(v, normal) - offset) < 1e-6 ? [n] : [],
          ),
        });
      }
  // Order each face's corners around it, so that it draws as one polygon.
  for (const face of faces) {
    const points = face.corners.map((n) => vertices[n] as Vector);
    const centre = points
      .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]] as Vector, [0, 0, 0] as Vector)
      .map((n) => n / points.length) as Vector;
    const u = normalise(minus(points[0] as Vector, centre));
    const w = cross(face.normal, u);
    const angle = (n: number) => {
      const d = minus(vertices[n] as Vector, centre);
      return Math.atan2(dot(d, w), dot(d, u));
    };
    face.corners.sort((a, b) => angle(a) - angle(b));
  }
  return { vertices, faces, size };
}
const SOLIDS = CORNERS.map((points, n) => build(points, SIZES[n] ?? 27));

/** The 8 × 8 ordered dither: a pixel is inked where its darkness passes its cell's threshold. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((n) => (n + 0.5) / 64);
const threshold = (x: number, y: number) => BAYER[(y % 8) * 8 + (x % 8)] ?? 0.5;

/** Draws the shelf, the shadows and the solids at `time` seconds into `ink`, one byte a pixel. */
function draw(ink: Uint8Array, face: Int16Array, width: number, time: number) {
  ink.fill(0);
  face.fill(0);
  // A narrow picture draws the solids smaller, so that all five fit with room at either end.
  const scale = Math.min(1, (width - 8) / (ROW + 60));
  const row = Math.min(ROW, width - 64 * scale);
  const step = row / (SOLIDS.length - 1);
  const left = (width - row) / 2;
  for (
    let x = Math.max(0, Math.round(left - 24 * scale));
    x < Math.min(width, left + row + 40 * scale);
    x++
  )
    ink[SHELF * width + x] = 1;
  const tones: number[] = [0];
  SOLIDS.forEach((solid, n) => {
    const size = solid.size * scale;
    const cx = left + n * step;
    // The shadow on the shelf, a little to the right of the solid.
    for (let y = SHELF + 1; y < Math.min(HEIGHT, SHELF + 8); y++)
      for (let x = Math.floor(cx - size); x < Math.ceil(cx + size * 1.4); x++) {
        if (x < 0 || x >= width) continue;
        const q = ((x - cx - size * 0.3) / (size * 0.95)) ** 2 + ((y - SHELF - 3) / 2.5) ** 2;
        if (q < 1 && 0.4 * (1 - q * 0.6) > threshold(x, y)) ink[y * width + x] = 1;
      }
    const [first, second] = AXES[n] ?? [];
    const turned = multiply(
      about(
        second?.axis ?? [0, 1, 0],
        ((second?.sign ?? 1) * ((SPIN[1] ?? 0) * time * Math.PI)) / 30 + n,
      ),
      about(
        first?.axis ?? [1, 0, 0],
        ((first?.sign ?? 1) * ((SPIN[0] ?? 0) * time * Math.PI)) / 30 + n * 2,
      ),
    );
    const vertices = solid.vertices.map((v) => apply(turned, v));
    // In the air just above the shelf, whichever way it is turned.
    const cy = SHELF - size - 4;
    for (const f of solid.faces) {
      const normal = apply(turned, f.normal);
      if (normal[2] <= 1e-6) continue;
      const id = tones.length;
      tones.push(0.06 + (1 - Math.max(0, dot(normal, LIGHT))) * 0.86);
      const points = f.corners.map((c) => {
        const v = vertices[c] as Vector;
        return [cx + v[0] * size, cy - v[1] * size] as [number, number];
      });
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      for (
        let y = Math.max(0, Math.floor(Math.min(...ys)));
        y < Math.min(HEIGHT, Math.ceil(Math.max(...ys)));
        y++
      )
        for (
          let x = Math.max(0, Math.floor(Math.min(...xs)));
          x < Math.min(width, Math.ceil(Math.max(...xs)));
          x++
        ) {
          // Inside when the pixel's centre is on the inner side of every edge.
          let inside = true;
          for (let e = 0; e < points.length && inside; e++) {
            const [a, b] = [points[e], points[(e + 1) % points.length]] as [
              [number, number],
              [number, number],
            ];
            inside = (b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0]) <= 0;
          }
          if (inside) face[y * width + x] = id;
        }
    }
  });
  // Each face in its dither, with a line where one face meets another or the background.
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const id = face[i] ?? 0;
      if (id === 0) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === HEIGHT - 1 ||
        face[i - 1] === 0 ||
        face[i - width] === 0 ||
        face[i + 1] !== id ||
        face[i + width] !== id;
      ink[i] = edge || (tones[id] ?? 0) > threshold(x, y) ? 1 : 0;
    }
}

/** The picture, with a button that stops and starts it. It starts stopped for reduced motion. */
export default function Visualization() {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Kept across a pause, so that the solids go on from where they stopped.
  const state = useRef({ time: 0 });
  const [playing, setPlaying] = useState(
    () =>
      typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useLayoutEffect(() => {
    const box = frame.current;
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!box || !element || !context) return;
    const scene = state.current;
    let width = 0;
    let ink = new Uint8Array(0);
    let face = new Int16Array(0);
    let image = context.createImageData(1, 1);
    let [last, tick] = [0, 0];
    let visible = true;
    let colour = [0, 0, 0];

    const paint = () => {
      if (width === 0) return;
      draw(ink, face, width, scene.time);
      const { data } = image;
      for (let i = 0; i < ink.length; i++) {
        data[i * 4] = colour[0] ?? 0;
        data[i * 4 + 1] = colour[1] ?? 0;
        data[i * 4 + 2] = colour[2] ?? 0;
        data[i * 4 + 3] = ink[i] ? 255 : 0;
      }
      context.putImageData(image, 0, 0);
    };
    // The picture is as wide as its box allows at a whole number of CSS pixels per scene pixel.
    const fit = () => {
      const room = box.clientWidth;
      const scale = pixelFor(room);
      const next = Math.max(1, Math.floor(room / scale));
      element.style.width = `${next * scale}px`;
      if (next === width) return;
      width = next;
      element.width = width;
      ink = new Uint8Array(width * HEIGHT);
      face = new Int16Array(width * HEIGHT);
      image = context.createImageData(width, HEIGHT);
      paint();
    };
    // The stylesheet gives the canvas the page's ink as its colour; the rest stays transparent.
    const readColour = () => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      colour = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      paint();
    };
    const step = (now: number) => {
      tick = requestAnimationFrame(step);
      if (!visible || now - last < 1000 / FPS) return;
      scene.time += last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      paint();
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    const sized = new ResizeObserver(fit);
    readColour();
    fit();
    scheme.addEventListener('change', readColour);
    seen.observe(element);
    sized.observe(box);
    if (playing) tick = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(tick);
      scheme.removeEventListener('change', readColour);
      seen.disconnect();
      sized.disconnect();
    };
  }, [playing]);

  return (
    <div ref={frame} className={styles.scene}>
      <canvas
        ref={canvas}
        className={styles.canvas}
        width={160}
        height={HEIGHT}
        role="img"
        aria-label="The five Platonic solids tumbling slowly above a shelf: a tetrahedron, a cube, an octahedron, a dodecahedron and an icosahedron."
      />
      <button
        type="button"
        className={styles.toggle}
        aria-label={playing ? 'Pause animation' : 'Play animation'}
        onClick={() => setPlaying(!playing)}
      >
        <svg viewBox="0 0 7 7" aria-hidden="true">
          <path d={playing ? 'M1 0h2v7H1zM5 0h2v7H5z' : 'M1 0h1v1h1v1h1v1h1v1H4v1H3v1H2v1H1z'} />
        </svg>
      </button>
    </div>
  );
}
