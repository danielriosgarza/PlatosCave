import { useEffect, useRef, useState } from 'react';
import styles from './_visualization.module.css';

// The scene of the front page: a 1-bit cave in which a scholar walks from station to station, one
// station for each tab of a topic. Everything is drawn here, in two colours that follow the
// page's ink and paper, so the file needs no image. A name that starts with `_` makes this file a
// helper of `index.tsx` and not a page. To change the scene, edit the constants below; to replace
// it, export another component from this file; to remove it, delete its import and its element
// in `index.tsx`.

/** The size of the drawing in pixels; the stylesheet scales it to the width of its column. */
const WIDTH = 256;
const HEIGHT = 112;
/** The top of the cave floor. */
const GROUND = 94;
/** Where the scholar stands on the screen while the cave scrolls past. */
const SCHOLAR_X = 74;
/** Walking speed in pixels per second, and how long the scholar stays at a station. */
const SPEED = 20;
const PAUSE_SECONDS = 2.2;
/** Frames per second: low on purpose, as on an old handheld. */
const FPS = 24;
/** How far, in pixels, the nearest layer shifts when the pointer moves across the scene. */
const POINTER_SHIFT = 12;
/** Changes the stars, the mountains, the ruins and the rocks. */
const SEED = 7;

/** One station per tab, in the order of the tabs. `sprite` is drawn with its foot on the floor. */
const STATIONS: { label: string; sprite: string[] }[] = [
  {
    label: 'SLIDES',
    sprite: [
      '################',
      '#oooooooooooooo#',
      '#o######ooooooo#',
      '#oooooooooooooo#',
      '#o###o####ooooo#',
      '#oooooooooooooo#',
      '#o#####o###oooo#',
      '#oooooooooooooo#',
      '################',
      '.......##.......',
      '.......##.......',
      '.......##.......',
      '......####......',
      '.....##..##.....',
      '....##....##....',
      '...##......##...',
    ],
  },
  {
    label: 'READING',
    sprite: [
      '##############',
      '#oooooooooooo#',
      '#o#o##o#o##oo#',
      '#o#o##o#o##o##',
      '#o#o##o#o##o##',
      '##############',
      '#oooooooooooo#',
      '#o##o#o###o#o#',
      '#o##o#o###o#o#',
      '#o##o#o###o#o#',
      '##############',
      '#oooooooooooo#',
      '#o#o###oo#o#o#',
      '#o#o###o##o#o#',
      '#o#o###o##o#o#',
      '##############',
    ],
  },
  {
    label: 'EXERCISES',
    sprite: [
      '.....######.....',
      '...##oooooo##...',
      '..#oooo##oooo#..',
      '.#ooo##oo##ooo#.',
      '.#ooooooo##ooo#.',
      '#oooooooo##oooo#',
      '#ooooooo##ooooo#',
      '#oooooo##oooooo#',
      '#oooooo##oooooo#',
      '#oooooooooooooo#',
      '#oooooo##oooooo#',
      '#oooooo##oooooo#',
      '#oooooooooooooo#',
      '#oooooooooooooo#',
      '#oooooooooooooo#',
      '################',
    ],
  },
  {
    label: 'NOTEBOOKS',
    sprite: [
      '..############..',
      '..#oooooooooo#..',
      '..#o#oooooooo#..',
      '..#oo#ooooooo#..',
      '..#o#oo###ooo#..',
      '..#oooooooooo#..',
      '..#o##o#o#ooo#..',
      '..#oooooooooo#..',
      '..############..',
      '.......##.......',
      '.....######.....',
      '................',
      '################',
      '#o#o#o#o#o#o#oo#',
      '#oo#o#o#o#o#o#o#',
      '################',
    ],
  },
  {
    label: 'TESTS',
    sprite: [
      '...##########...',
      '...#oooooooo#...',
      '...#o####ooo#...',
      '...#oooooooo#...',
      '...#o###oooo#...',
      '...#oooooo#o#...',
      '...#o#ooo#oo#...',
      '...#oo#o#ooo#...',
      '...#ooo#oooo#...',
      '...##########...',
      '################',
      '################',
      '.##..........##.',
      '.##..........##.',
      '.##..........##.',
      '.##..........##.',
    ],
  },
];
/** Distance between two stations along the floor; the five repeat after five of these. */
const STATION_GAP = 104;

/** The scholar, facing right: two walking frames and one for standing. `o` is paper. */
const SCHOLAR = {
  head: ['....##....', '...####...', '..######..', '...#oo#...', '...#o##...', '....##....'],
  body: ['..######..', '.#.####.#.', '.#.####.#.', '...####...', '...####...', '..######..'],
  legs: [
    ['..#....#..', '.##....##.'],
    ['...#..#...', '...##.##..'],
    ['...#..#...', '..##..##..'],
  ],
};

/** A 3 by 5 pixel letter for each letter the labels use. */
const FONT: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
};

/** The 4 by 4 Bayer matrix: ordered dithering gives grey in two colours. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dither = (x: number, y: number) => ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;

/** A number from 0 to 1 that depends only on its arguments and SEED. */
function hash(a: number, b = 0): number {
  let h = Math.imul(a ^ (SEED * 0x9e3779b1), 0x85ebca6b) ^ Math.imul(b + 0x27d4eb2f, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** Where the scholar is and what they do: the state that moves from frame to frame. */
interface Walk {
  /** The scholar's place along the floor, in pixels from the first station. */
  x: number;
  /** The station walked to next, counted without end. */
  next: number;
  /** Seconds left standing at the current station; 0 while walking. */
  wait: number;
}
const standAt = (station: number) => station * STATION_GAP - 24;

function advance(walk: Walk, seconds: number): Walk {
  if (walk.wait > 0) {
    const wait = walk.wait - seconds;
    return wait > 0 ? { ...walk, wait } : { ...walk, wait: 0, next: walk.next + 1 };
  }
  const x = walk.x + SPEED * seconds;
  const stop = standAt(walk.next);
  return x >= stop ? { x: stop, next: walk.next, wait: PAUSE_SECONDS } : { ...walk, x };
}

/** One frame into `pixels` (1 is ink, 0 is paper) at `time` seconds, with the pointer at `shift`. */
function draw(pixels: Uint8Array, walk: Walk, time: number, shift: number): void {
  pixels.fill(0);
  const set = (x: number, y: number, ink: number) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y * WIDTH + (x | 0)] = ink;
  };
  const camera = walk.x - SCHOLAR_X;
  /** How far a layer has scrolled: deeper layers (smaller depth) scroll less. */
  const view = (depth: number) => Math.round(camera * depth + shift * POINTER_SHIFT * depth);
  const sprite = (rows: string[], left: number, top: number) =>
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '.') set(left + x, top + y, row[x] === '#' ? 1 : 0);
      }
    });

  // Stars, which twinkle, and a crescent moon that never moves.
  const stars = view(0.05);
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(wrap(hash(i, 1) * 512 - stars, 512));
    const y = 14 + Math.floor(hash(i, 2) * 36);
    if (hash(i, Math.floor(time * 2 + hash(i, 3) * 8)) > 0.12) set(x, y, 1);
    if (hash(i, 4) > 0.85) {
      for (const d of [-1, 1]) {
        set(x + d, y, 1);
        set(x, y + d, 1);
      }
    }
  }
  for (let y = -9; y <= 9; y++) {
    for (let x = -9; x <= 9; x++) {
      const inside = x * x + y * y <= 81;
      if (inside && (x + 4) ** 2 + (y - 2) ** 2 > 64) set(206 + x, 28 + y, 1);
    }
  }

  // Far mountains, a quarter grey with an ink ridge.
  const far = view(0.2);
  for (let x = 0; x < WIDTH; x++) {
    const at = wrap(x + far, 416);
    let top = GROUND;
    for (let peak = 0; peak < 6; peak++) {
      const centre = peak * 69 + hash(peak, 5) * 36;
      const height = 18 + hash(peak, 6) * 28;
      for (const c of [centre - 416, centre, centre + 416]) {
        top = Math.min(top, GROUND - 4 - height + Math.abs(at - c) * 0.9);
      }
    }
    for (let y = Math.ceil(top); y < GROUND; y++) {
      if (y === Math.ceil(top) || dither(x + far, y) < 0.25) set(x, y, 1);
    }
  }

  // Ruins nearer by: columns, some broken, half grey with ink edges.
  const near = view(0.5);
  for (let i = 0; i < 6; i++) {
    const base = i * 56 + hash(i, 7) * 24;
    const height = 12 + Math.floor(hash(i, 8) * 24);
    const left = Math.floor(wrap(base - near + 20, 336)) - 20;
    for (let y = GROUND - height; y < GROUND; y++) {
      for (let x = -1; x < 7; x++) {
        const capital = y < GROUND - height + 3 || y >= GROUND - 2;
        if (!capital && (x < 0 || x > 5)) continue;
        const edge = capital || x === 0 || x === 5;
        if (edge || (x + y) % 2 === 0) set(left + x, y, 1);
      }
    }
  }

  // Torches between the stations. Their light clears the grey of the far layers around them.
  const floor = view(1);
  const torches: number[] = [];
  for (let n = Math.floor(floor / STATION_GAP) - 1; n <= (floor + WIDTH) / STATION_GAP + 1; n++) {
    torches.push(n * STATION_GAP + STATION_GAP / 2 - floor);
  }
  for (const torch of torches) {
    const radius = 26 + Math.sin(time * 9 + torch) * 1.5;
    for (let y = GROUND - 52; y < GROUND; y++) {
      for (let x = Math.floor(torch - radius); x <= torch + radius; x++) {
        const distance = Math.hypot(x - torch, y - (GROUND - 26)) / radius;
        if (distance < 1 && distance < 0.55 + 0.45 * dither(x, y)) set(x, y, 0);
      }
    }
  }

  // The scholar's shadow on the back wall, cast by the nearest torch: the cave of the allegory.
  const torch = torches.reduce((a, b) =>
    Math.abs(b - SCHOLAR_X) < Math.abs(a - SCHOLAR_X) ? b : a,
  );
  const outline = [...SCHOLAR.head, ...SCHOLAR.body, ...(SCHOLAR.legs[0] ?? [])];
  const shadowLeft = SCHOLAR_X + (SCHOLAR_X - torch) * 0.7 - 5;
  outline.forEach((row, y) => {
    for (let x = 0; x < row.length * 2; x++) {
      if (row[x >> 1] === '.') continue;
      for (const dy of [0, 1]) {
        const sx = Math.round(shadowLeft + x);
        const sy = GROUND - outline.length * 2 - 6 + y * 2 + dy;
        if ((sx + sy) % 2 === 0) set(sx, sy, 1);
      }
    }
  });

  // The floor: solid ink with flecks of paper and an uneven edge.
  for (let x = 0; x < WIDTH; x++) {
    const at = x + floor;
    const edge = GROUND + (hash(Math.floor(at / 6), 9) > 0.7 ? 1 : 0);
    for (let y = edge; y < HEIGHT; y++) set(x, y, y < GROUND + 2 || hash(at, y) > 0.04 ? 1 : 0);
  }

  // The stations with their labels, and the torches' posts and flames.
  const first = Math.floor((floor - 40) / STATION_GAP);
  for (let n = first; n <= first + 4; n++) {
    const station = STATIONS[wrap(n, STATIONS.length)];
    if (!station) continue;
    const { label, sprite: rows } = station;
    const centre = n * STATION_GAP - floor;
    sprite(rows, Math.round(centre - (rows[0]?.length ?? 0) / 2), GROUND - rows.length);
    // The label on a small sign: paper inside an ink frame, so it reads over the grey behind it.
    const [textLeft, textTop] = [
      Math.round(centre - (label.length * 4 - 1) / 2),
      GROUND - rows.length - 10,
    ];
    for (let y = textTop - 2; y <= textTop + 6; y++) {
      for (let x = textLeft - 2; x <= textLeft + label.length * 4; x++) {
        const frame =
          y === textTop - 2 ||
          y === textTop + 6 ||
          x === textLeft - 2 ||
          x === textLeft + label.length * 4;
        set(x, y, frame ? 1 : 0);
      }
    }
    [...label].forEach((letter, i) => {
      sprite(FONT[letter] ?? [], textLeft + i * 4, textTop);
    });
  }
  for (const at of torches) {
    const x = Math.round(at);
    for (let y = GROUND - 22; y < GROUND; y++) set(x, y, 1);
    sprite(['#.#', '###'], x - 1, GROUND - 24);
    const flame = Math.floor(time * 8 + at) % 2 === 0;
    sprite(flame ? ['.#.', '##.', '###', '.#.'] : ['.#.', '.##', '###', '.#.'], x - 1, GROUND - 29);
  }

  // The scholar, and three dots that come one by one while they stay at a station.
  const step = walk.wait > 0 ? 2 : Math.floor(time * 6) % 2;
  const scholar = [...SCHOLAR.head, ...SCHOLAR.body, ...(SCHOLAR.legs[step] ?? [])];
  sprite(scholar, SCHOLAR_X - 5, GROUND - scholar.length);
  if (walk.wait > 0) {
    const dots = Math.min(3, Math.floor((PAUSE_SECONDS - walk.wait) * 2) + 1);
    for (let i = 0; i < dots; i++) sprite(['##', '##'], SCHOLAR_X + 6 + i * 4, GROUND - 17);
  }

  // Rocks hanging from the cave's ceiling, the nearest layer.
  const roof = view(1.25);
  for (let x = 0; x < WIDTH; x++) {
    const at = x + roof;
    const block = Math.floor(at / 26);
    const length = 3 + hash(block, 10) * 18;
    const half = 3 + hash(block, 11) * 6;
    const offset = Math.abs(wrap(at, 26) - 13);
    const bottom = 6 + Math.max(0, length - (offset * length) / half);
    for (let y = 0; y < bottom; y++) set(x, y, 1);
  }
}

/** The colour `css` names, as red, green and blue. */
function rgb(context: CanvasRenderingContext2D, css: string): [number, number, number] {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** The scene, with a button that stops and starts it. It starts stopped for reduced motion. */
export default function Visualization() {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Kept across a pause, so that the scene goes on where it stopped.
  const state = useRef({
    walk: { x: standAt(0) - 30, next: 0, wait: 0 } as Walk,
    time: 0,
    shift: 0,
  });
  const [playing, setPlaying] = useState(
    () =>
      typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d', { willReadFrequently: true });
    if (!element || !context) return;
    const scene = state.current;
    const pixels = new Uint8Array(WIDTH * HEIGHT);
    const image = context.createImageData(WIDTH, HEIGHT);
    let [target, last, frame] = [scene.shift, 0, 0];
    let visible = true;
    let colours: Record<'ink' | 'paper', [number, number, number]> = {
      ink: [0, 0, 0],
      paper: [255, 255, 255],
    };

    const paint = () => {
      draw(pixels, scene.walk, scene.time, scene.shift);
      const { data } = image;
      for (let i = 0; i < pixels.length; i++) {
        const colour = pixels[i] ? colours.ink : colours.paper;
        data[i * 4] = colour[0];
        data[i * 4 + 1] = colour[1];
        data[i * 4 + 2] = colour[2];
        data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    // The stylesheet gives the canvas the page's ink as its colour and paper as its background.
    const readColours = () => {
      const style = getComputedStyle(element);
      colours = { ink: rgb(context, style.color), paper: rgb(context, style.backgroundColor) };
      paint();
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || now - last < 1000 / FPS) return;
      const seconds = last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      scene.time += seconds;
      scene.walk = advance(scene.walk, seconds);
      scene.shift += (target - scene.shift) * 0.15;
      paint();
    };
    const point = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      target = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const seen = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true));
    readColours();
    scheme.addEventListener('change', readColours);
    seen.observe(element);
    if (playing) {
      element.addEventListener('pointermove', point);
      frame = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('pointermove', point);
      scheme.removeEventListener('change', readColours);
      seen.disconnect();
    };
  }, [playing]);

  return (
    <div className={styles.scene}>
      <canvas
        ref={canvas}
        className={styles.canvas}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label="A pixel scholar walks through a cave from station to station: a screen for slides, a bookshelf for reading, a puzzle gate for exercises, a terminal for notebooks and a desk for tests."
      />
      <button type="button" className={styles.toggle} onClick={() => setPlaying(!playing)}>
        {playing ? 'Pause animation' : 'Play animation'}
      </button>
    </div>
  );
}
