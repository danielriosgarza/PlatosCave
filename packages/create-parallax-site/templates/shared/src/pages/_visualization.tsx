import { useLayoutEffect, useRef, useState } from 'react';
import styles from './_visualization.module.css';

// The scene of the front page: a 1-bit cave in which a scholar walks from station to station, one
// station for each tab of a topic, by the light of a torch over each. Everything is drawn here, in
// two colours that follow the page's ink and paper, so the file needs no image. A name that starts
// with `_` makes this file a helper of `index.tsx` and not a page. To change the scene, edit the
// constants below; to replace it, export another component from this file; to remove it, delete
// its import and its element in `index.tsx`.

/** The height of the drawing in scene pixels. Its width is whatever its column holds. */
const HEIGHT = 112;
/** CSS pixels per scene pixel: a whole number, so that every pixel is crisp, and fewer in a
 * column too narrow for MIN_WIDTH pixels. */
const PIXEL = 3;
const MIN_WIDTH = 144;
/** The vault of the ceiling: how far down its ribs and its crowns reach, and the span of an arch. */
const VAULT = { rib: 19, crown: 8, span: 48 };
/** The top of the wall behind the scholar, and the floor. */
const WALL_TOP = 44;
const GROUND = 100;
/** Where the scholar stands, as a share of the scene's width, while the cave scrolls past. */
const SCHOLAR_AT = 0.25;
/** Walking speed in pixels per second, and how long the scholar stays at a station. */
const SPEED = 20;
const PAUSE_SECONDS = 2.4;
/** Frames per second: low on purpose, as on an old handheld. */
const FPS = 24;
/** How far, in pixels, the ceiling shifts when the pointer moves across the scene. */
const POINTER_SHIFT = 16;
/** Changes the stars, the mountains, the stalactites, the cracks and the pebbles. */
const SEED = 7;
/** Distance between two stations along the floor; the five repeat after five of these. */
const STATION_GAP = 84;
/** Each torch hangs this far to the left of its station, and this far down the wall. */
const TORCH_AT = { left: 14, down: 10 };
/** The pool of torchlight on the wall, an ellipse centred `below` the torch: paper within `from`
 * of its radii, then three bands of grey to its edge, and solid ink beyond. */
const LIGHT = { across: 34, down: 36, below: 18, from: 0.55 };
/** The scholar's shadow on the wall, as a share of ink. */
const SHADOW = 0.5;
/** The rows of the wall, from its top, along which its strata run. */
const STRATA = [18, 46];

/** A drawing as rows of `#` (ink), `o` (paper) and `.` (nothing); short rows are padded. */
function bitmap(text: string): string[] {
  const rows = text
    .trim()
    .split('\n')
    .map((row) => row.trim());
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(width, '.'));
}

/** One station per tab, in the order of the tabs. Each sprite stands with its foot on the floor. */
const STATIONS: { label: string; sprite: string[] }[] = [
  {
    label: 'SLIDES',
    sprite: bitmap(`
      #####################
      #ooooooooooooooooooo#
      #oo########ooooooooo#
      #ooooooooooooooooooo#
      #oo#####ooooooooo##o#
      #oooooooooooooooo##o#
      #oo######ooooo##o##o#
      #ooooooooooooo##o##o#
      #oo####oooo##o##o##o#
      #oooooooooo##o##o##o#
      #####################
      .........###.........
      .........###.........
      ..........#..........
      .........###.........
      ........#.#.#........
      .......#..#..#.......
      ......#...#...#......
    `),
  },
  {
    label: 'READING',
    sprite: bitmap(`
      ###############
      #oooo#oooooo#o#
      #o##o#oooo#o#o#
      #o##o#o##o#o#o#
      #o##o#o##o#o#o#
      #o##o#o##o#o#o#
      ###############
      #o#oooooo##ooo#
      #o#oooo#o##ooo#
      #o#o##o#o##ooo#
      #o#o##o#o##o#o#
      #o#o##o#o##o#o#
      ###############
      #oooo#oooooooo#
      #o##o#oooo##oo#
      #o##o#o##o##oo#
      #o##o#o##o##oo#
      #o##o#o##o##oo#
      #o##o#o##o##oo#
      ###############
    `),
  },
  {
    label: 'EXERCISES',
    sprite: bitmap(`
      ###################
      #ooooooooooooooooo#
      #oo###oooooooooooo#
      #o#ooo#ooooooooooo#
      #ooooo#ooooooooooo#
      #oooo#ooooooooo#oo#
      #ooo#ooooooooo#ooo#
      #ooo#oooooo#o#oooo#
      #ooooooooooo#ooooo#
      #ooo#ooooooooooooo#
      #ooooooooooooooooo#
      ###################
      ....#.........#....
      ....#.........#....
      ...#...........#...
      ...#...........#...
      ..#.............#..
      ..#.............#..
    `),
  },
  {
    label: 'NOTEBOOKS',
    sprite: bitmap(`
      ...############...
      ...#oooooooooo#...
      ...#o#oooooooo#...
      ...#oo#o####oo#...
      ...#o#oooooooo#...
      ...#oooooooooo#...
      ...#oooooooooo#...
      ...############...
      .......####.......
      ......######......
      ##################
      .#..............#.
      .#..............#.
      .#..............#.
      .#..............#.
    `),
  },
  {
    label: 'TESTS',
    sprite: bitmap(`
      ###########
      .#ooooooo#.
      .#o#####o#.
      ..#o###o#..
      ...#o#o#...
      ....#o#....
      ....#o#....
      ...#ooo#...
      ..#ooooo#..
      .#ooo#ooo#.
      .#oo###oo#.
      .#o#####o#.
      ###########
      ....###....
      ..#######..
    `),
  },
];

/** The scholar, facing right, in a gown and cap with a book: the head, the gown, the book held out
 * in front with the paper around it, and the legs of a stride and of a step. */
const SCHOLAR = {
  head: bitmap(`
    .#########..
    ...######.#.
    ...#oooo#.#.
    ...#oo#o#...
    ...#oooo##..
    ...#oooo#...
    ....####....
    .....##.....
  `),
  gown: bitmap(`
    ...######...
    ..########..
    ..########..
    .#########..
    .#########..
    .#########..
    .#########..
    ##########..
    ###########.
  `),
  book: bitmap(`
    oooo
    ####
    #oo#
    #oo#
    ####
    oooo
  `),
  legs: {
    stride: bitmap(`
      ....##.##...
      ...##...##..
      ...##...##..
      ..##.....##.
      .###.....###
    `),
    step: bitmap(`
      .....##.....
      .....##.....
      .....##.....
      .....##.....
      ....####....
    `),
  },
  /** The walk: which legs, how far the body lifts, and how far forward the book swings. */
  walk: [
    { legs: 'stride', lift: 0, swing: 0 },
    { legs: 'step', lift: 1, swing: 0 },
    { legs: 'stride', lift: 0, swing: 1 },
    { legs: 'step', lift: 1, swing: 1 },
  ] as const,
  standing: { legs: 'step', lift: 0, swing: 0 } as const,
};

/** The torch over a station: its holder on the wall and the two frames of its flame. */
const TORCH = {
  holder: bitmap(`
    #####
    .###.
    ..#..
    ..#..
    .###.
  `),
  flames: [
    bitmap(`
      ..#..
      ..##.
      .#o#.
      .#o##
      .###.
    `),
    bitmap(`
      ..#..
      .##..
      .#o#.
      ##o#.
      .###.
    `),
  ],
};

/** A bat, wings up and wings down. */
const BAT = [bitmap('#.....#\n.##.##.\n...#...'), bitmap('.......\n...#...\n##.#.##')];

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
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Where the scholar is and what they do: the state that moves from frame to frame. */
interface Walk {
  /** The scholar's place along the floor, in pixels from the first station. */
  x: number;
  /** The station walked to next, counted without end. */
  next: number;
  /** Seconds left standing at the current station; 0 while walking. */
  wait: number;
}
const standAt = (station: number) => station * STATION_GAP - 16;

function advance(walk: Walk, seconds: number): Walk {
  if (walk.wait > 0) {
    const wait = walk.wait - seconds;
    return wait > 0 ? { ...walk, wait } : { ...walk, wait: 0, next: walk.next + 1 };
  }
  const x = walk.x + SPEED * seconds;
  const stop = standAt(walk.next);
  return x >= stop ? { x: stop, next: walk.next, wait: PAUSE_SECONDS } : { ...walk, x };
}

/** A ridge of mountains: for each `x` along it, how far its skyline rises above the wall. */
function ridge(x: number, period: number, peaks: number, low: number, high: number, slope: number) {
  const at = wrap(x, period);
  let rise = 0;
  for (let peak = 0; peak < peaks; peak++) {
    const centre = ((peak + hash(peak, 5 + peaks)) * period) / peaks;
    const height = low + hash(peak, 6 + peaks) * (high - low);
    for (const c of [centre - period, centre, centre + period]) {
      rise = Math.max(rise, height - Math.abs(at - c) * slope);
    }
  }
  return Math.round(rise);
}

/** The ceiling at `at` along its own layer: the vault, its ragged edge, and the stalactite of the
 * arch, if it has one. */
function ceiling(at: number): { bottom: number; drip: number; dripX: number } {
  const t = wrap(at, VAULT.span) / VAULT.span;
  const arch = VAULT.rib - (VAULT.rib - VAULT.crown) * Math.sin(Math.PI * t);
  const [a, b] = [hash(Math.floor(at / 8), 14), hash(Math.floor(at / 8) + 1, 14)];
  const ragged = (a + (b - a) * (wrap(at, 8) / 8)) * 2;
  const block = Math.floor(at / VAULT.span);
  const drip = hash(block, 10) < 0.7 ? 3 + hash(block, 11) ** 2 * 16 : 0;
  const dripX = block * VAULT.span + 8 + Math.floor(hash(block, 13) * (VAULT.span - 16));
  const half = 2 + hash(block, 12) * 3;
  const bottom = arch + ragged + Math.max(0, drip * (1 - Math.abs(at - dripX) / half));
  return { bottom, drip, dripX };
}

/** One frame into `pixels`, `width` wide, at `time` seconds and with the pointer at `shift`. A
 * pixel is 0 where the cave is light and 1 where it is dark; the night beyond its mouth is 2 for
 * the paper and 3 for the ink, so that the sky follows the page and the torchlight does not. */
function draw(pixels: Uint8Array, width: number, walk: Walk, time: number, shift: number): void {
  pixels.fill(0);
  const set = (x: number, y: number, ink: number) => {
    if (x >= 0 && x < width && y >= 0 && y < HEIGHT) pixels[y * width + (x | 0)] = ink;
  };
  const scholarX = Math.round(width * SCHOLAR_AT);
  const camera = walk.x - scholarX;
  /** How far a layer has scrolled: deeper layers (smaller depth) scroll less, and the pointer turns
   * the scene about the floor the scholar stands on. */
  const view = (depth: number) => Math.round(camera * depth + shift * POINTER_SHIFT * (depth - 1));
  /** Draws `rows` with its top left corner at (left, top); with `halo`, a line of paper around it
   * keeps it clear of what is behind, everywhere or where the given test holds. */
  const sprite = (
    rows: string[],
    left: number,
    top: number,
    halo: boolean | ((x: number, y: number) => boolean) = false,
  ) => {
    const around = typeof halo === 'function' ? halo : () => halo;
    for (const [y, row] of rows.entries()) {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '.' || !halo) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [px, py] = [left + x + dx, top + y + dy];
            if ((rows[y + dy]?.[x + dx] ?? '.') === '.' && around(px, py)) set(px, py, 0);
          }
        }
      }
    }
    for (const [y, row] of rows.entries()) {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '.') set(left + x, top + y, row[x] === '#' ? 1 : 0);
      }
    }
  };

  // The night beyond the mouth of the cave: stars, a few of which twinkle, and a crescent moon.
  const sky = view(0.05);
  for (let i = 0; i < 28; i++) {
    const x = Math.floor(wrap(hash(i, 1) * 512 - sky, 512));
    const y = 4 + Math.floor(hash(i, 2) * (WALL_TOP - 12));
    if (hash(i, Math.floor(time + hash(i, 3) * 8)) > 0.1) set(x, y, 1);
    if (hash(i, 4) > 0.88) {
      for (const d of [-1, 1]) {
        set(x + d, y, 1);
        set(x, y + d, 1);
      }
    }
  }
  const [moonX, moonY] = [width - 40, 24];
  for (let y = -6; y <= 6; y++) {
    for (let x = -6; x <= 6; x++) {
      if (x * x + y * y <= 36 && (x + 3) ** 2 + (y - 1) ** 2 > 27) set(moonX + x, moonY + y, 1);
    }
  }

  // Two ridges of mountains under their skylines, stippled, the near one the denser.
  const far = view(0.12);
  const near = view(0.25);
  for (let x = 0; x < width; x++) {
    const ridges = [
      [far, ridge(x + far, 360, 5, 8, 20, 0.5), 0.2],
      [near, ridge(x + near, 300, 4, 3, 12, 0.8), 0.4],
    ] as const;
    for (const [scroll, rise, grey] of ridges) {
      for (let y = WALL_TOP - rise; y < WALL_TOP; y++) {
        set(x, y, y === WALL_TOP - rise || dither(x + scroll, y) < grey ? 1 : 0);
      }
    }
  }

  // The ruins beyond the wall: the columns of a temple, and one left standing alone.
  const mid = view(0.5);
  const column = (x: number, height: number, capital: boolean) => {
    for (let y = WALL_TOP - height; y < WALL_TOP; y++) {
      for (let dx = -2; dx <= 2; dx++) set(x + dx, y, Math.abs(dx) === 2 ? 1 : 0);
    }
    for (let dx = -3; dx <= 3; dx++) {
      if (capital || (Math.abs(dx) < 3 && dx % 2 === 0)) set(x + dx, WALL_TOP - height, 1);
    }
  };
  for (let n = Math.floor(mid / 300) - 1; n <= (mid + width) / 300; n++) {
    const left = n * 300 - mid;
    column(left + 40, 11, true);
    column(left + 50, 11, true);
    column(left + 60, 7, false);
    for (let x = left + 36; x <= left + 54; x++) {
      set(x, WALL_TOP - 13, 1);
      set(x, WALL_TOP - 12, x === left + 54 ? 1 : 0);
      set(x, WALL_TOP - 11, 1);
    }
    column(left + 186, 10, true);
    column(left + 196, 4, false);
  }

  // A bat crosses the mouth of the cave once in a while.
  const flight = wrap(time * 26, 900);
  if (flight < width + 20) {
    const flap = BAT[Math.floor(time * 10) % 2] ?? [];
    sprite(flap, width + 10 - flight, 28 + Math.round(Math.sin(time * 4) * 2), true);
  }

  // All of that is the night beyond the mouth of the cave.
  for (let i = 0; i < width * WALL_TOP; i++) pixels[i] = (pixels[i] ?? 0) | 2;

  // The wall, the cave of the allegory: solid rock but for the pools of torchlight, with its
  // strata and its cracks where the light is full.
  const floor = view(1);
  const first = Math.floor((floor - LIGHT.across) / STATION_GAP);
  const last = Math.ceil((floor + width + LIGHT.across) / STATION_GAP);
  const torchY = WALL_TOP + TORCH_AT.down;
  const torches: number[] = [];
  for (let n = first; n <= last; n++) torches.push(n * STATION_GAP - TORCH_AT.left - floor);
  const shade = (x: number, y: number) => {
    let near = 1;
    for (const torch of torches) {
      const d = Math.hypot((x - torch) / LIGHT.across, (y - torchY - LIGHT.below) / LIGHT.down);
      near = Math.min(near, clamp((d - LIGHT.from) / (1 - LIGHT.from), 0, 1));
    }
    return Math.round(near * 4) / 4;
  };
  const rock = (at: number, row: number) => {
    for (const [i, base] of STRATA.entries()) {
      const wave = Math.sin(at / 29 + i * 1.7) * 1.2 + hash(Math.floor(at / 64), 20 + i) * 2;
      if (row === base + Math.round(wave)) return hash(Math.floor(at / 24), 30 + i) > 0.12;
    }
    const block = Math.floor(at / 47);
    if (hash(block, 40) > 0.4) return false;
    const top = 2 + Math.floor(hash(block, 42) * 30);
    if (row < top || row >= top + 8 + hash(block, 43) * 12) return false;
    const drift = Math.round((row - top) * (hash(block, 44) - 0.5) * 0.6);
    return at === block * 47 + Math.floor(hash(block, 41) * 36) + drift;
  };
  for (let x = 0; x < width; x++) set(x, WALL_TOP, 1);
  for (let y = WALL_TOP + 1; y < GROUND; y++) {
    for (let x = 0; x < width; x++) {
      const dark = shade(x, y);
      const at = x + floor;
      if (dither(at, y) < dark || (dark === 0 && rock(at, y - WALL_TOP))) set(x, y, 1);
    }
  }

  // The scholar's shadow, thrown onto the lit wall behind and a little to the left: it leans away
  // from the nearest torch and stretches as the scholar walks out of its light.
  const nearest = torches.reduce((a, b) =>
    Math.abs(b - scholarX) < Math.abs(a - scholarX) ? b : a,
  );
  const away = clamp((scholarX - nearest) / LIGHT.across, -1, 1);
  const lean = away * 0.6 - 0.3;
  const stretch = 1 + Math.abs(away) * 0.4;
  const figure = [...SCHOLAR.head, ...SCHOLAR.gown, ...SCHOLAR.legs.step];
  const height = Math.round(figure.length * stretch);
  for (let i = 0; i < height; i++) {
    const row = figure[Math.min(figure.length - 1, Math.floor(i / stretch))] ?? '';
    const sy = GROUND - height + i;
    const left = scholarX - 11 + Math.round(lean * (height - i));
    for (let x = 0; x < row.length; x++) {
      const sx = left + x;
      if (row[x] === '.' || sy <= WALL_TOP || shade(sx, sy) > 0.25) continue;
      if (dither(sx, sy) < SHADOW) set(sx, sy, 1);
    }
  }

  // The stations, each in its torchlight with its label over the torch, where the light is full.
  for (let n = first; n <= last; n++) {
    const station = STATIONS[wrap(n, STATIONS.length)];
    if (!station) continue;
    const { label, sprite: rows } = station;
    const centre = n * STATION_GAP - floor;
    const across = rows[0]?.length ?? 0;
    const left = Math.round(centre - across / 2);
    sprite(rows, left, GROUND - rows.length, true);
    if (label === 'NOTEBOOKS' && Math.floor(time * 2) % 2 === 0) {
      sprite(['##'], left + 7, GROUND - rows.length + 5);
    }
    const textLeft = Math.round(centre - TORCH_AT.left + 2 - (label.length * 4 - 1) / 2);
    for (const [i, letter] of [...label].entries()) {
      sprite(FONT[letter] ?? [], textLeft + i * 4, GROUND - 32, (x, y) => shade(x, y) === 0);
    }
    // The torch: a flame in two frames, two embers dancing over it, and its holder on the wall.
    const torch = centre - TORCH_AT.left;
    for (const k of [0, 1]) {
      const beat = Math.floor(time * 6) + k * 3;
      const dx = Math.floor(hash(n + k * 7, beat) * 7) - 3;
      const dy = Math.floor(hash(n + k * 7, beat + 1) * 4);
      set(torch + dx, torchY - 5 - dy, 1);
    }
    sprite(TORCH.flames[Math.floor(time * 8 + n) % 2] ?? [], torch - 2, torchY - 3, true);
    sprite(TORCH.holder, torch - 2, torchY + 2, true);
  }

  // The scholar: walking, or standing at a station and nodding over the book.
  const standing = walk.wait > 0;
  const frame = standing
    ? SCHOLAR.standing
    : (SCHOLAR.walk[Math.floor(time * 8) % SCHOLAR.walk.length] ?? SCHOLAR.standing);
  const nod = standing && Math.floor(time * 1.5) % 2 === 1 ? 1 : 0;
  const legs = SCHOLAR.legs[frame.legs];
  const legsTop = GROUND - legs.length - frame.lift;
  const gownTop = legsTop - SCHOLAR.gown.length;
  sprite(SCHOLAR.head, scholarX - 6, gownTop - SCHOLAR.head.length + nod, true);
  sprite(SCHOLAR.gown, scholarX - 6, gownTop, true);
  sprite(SCHOLAR.book, scholarX + 3 + frame.swing, gownTop + 1);
  sprite(legs, scholarX - 6, legsTop, true);

  // The floor: solid rock, with a pebble here and there.
  for (let x = 0; x < width; x++) {
    const at = x + floor;
    const pebble = hash(Math.floor(at / 24), 9) > 0.55 && wrap(at, 24) < 2;
    for (let y = pebble ? GROUND - 1 : GROUND; y < HEIGHT; y++) set(x, y, 1);
  }

  // The ceiling, the nearest layer: a vault whose ribs reach down between its arches, with a ragged
  // edge and stalactites, some of them long. Its edge is a line of light: unseen against the paper
  // of a light theme, and the rim that parts it from the night in a dark one.
  const roof = view(1.3);
  for (let x = 0; x < width; x++) {
    const { bottom } = ceiling(x + roof);
    for (let y = 0; y < bottom; y++) set(x, y, y < bottom - 1 ? 1 : 0);
  }
  // Now and then a drop falls from a long stalactite and splashes on the floor.
  const splash = ['#...#', '.....', '#.....#'];
  for (let n = Math.floor(roof / VAULT.span); n <= (roof + width) / VAULT.span; n++) {
    const { bottom, drip, dripX } = ceiling(n * VAULT.span + 1);
    if (drip < 12) continue;
    const period = 9 + hash(n, 16) * 9;
    const phase = wrap(time + hash(n, 17) * period, period);
    if (phase > 1.1) continue;
    const x = dripX - roof;
    const tip = Math.floor(ceiling(dripX).bottom) || Math.floor(bottom);
    if (phase < 0.8) {
      sprite(['#', '#'], x, tip + Math.round((phase / 0.8) ** 2 * (GROUND - 3 - tip)), true);
    } else if (phase < 0.95) {
      sprite([splash[0] ?? ''], x - 2, GROUND - 3, true);
    } else {
      sprite([splash[2] ?? ''], x - 3, GROUND - 2, true);
    }
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
const luminance = ([r, g, b]: [number, number, number]) => r * 0.299 + g * 0.587 + b * 0.114;

/** The scene, with a button that stops and starts it. It starts stopped for reduced motion. */
export default function Visualization() {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Kept across a pause, so that the scene goes on where it stopped.
  const state = useRef({
    walk: { x: standAt(0) - 40, next: 0, wait: 0 } as Walk,
    time: 0,
    shift: 0,
  });
  const [playing, setPlaying] = useState(
    () =>
      typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useLayoutEffect(() => {
    const box = frame.current;
    const element = canvas.current;
    const context = element?.getContext('2d', { willReadFrequently: true });
    if (!box || !element || !context) return;
    const scene = state.current;
    let [width, pixels, image] = [0, new Uint8Array(0), context.createImageData(1, 1)];
    let [target, last, tick] = [scene.shift, 0, 0];
    let visible = true;
    let colours: Record<'ink' | 'paper' | 'dark' | 'light', [number, number, number]> = {
      ink: [0, 0, 0],
      paper: [255, 255, 255],
      dark: [0, 0, 0],
      light: [255, 255, 255],
    };

    const paint = () => {
      if (width === 0) return;
      draw(pixels, width, scene.walk, scene.time, scene.shift);
      const { data } = image;
      for (let i = 0; i < pixels.length; i++) {
        const pixel = pixels[i] ?? 0;
        const colour =
          pixel & 1
            ? pixel & 2
              ? colours.ink
              : colours.dark
            : pixel & 2
              ? colours.paper
              : colours.light;
        data[i * 4] = colour[0];
        data[i * 4 + 1] = colour[1];
        data[i * 4 + 2] = colour[2];
        data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    // The scene is as wide as its column allows at a whole number of CSS pixels per scene pixel.
    const fit = () => {
      const scale = clamp(Math.floor(box.clientWidth / MIN_WIDTH), 1, PIXEL);
      const next = Math.max(1, Math.floor(box.clientWidth / scale));
      if (next === width) return;
      width = next;
      element.width = width;
      element.style.width = `${width * scale}px`;
      pixels = new Uint8Array(width * HEIGHT);
      image = context.createImageData(width, HEIGHT);
      paint();
    };
    // The stylesheet gives the canvas the page's ink as its colour and paper as its background. The
    // night is drawn in them as they are; the cave in the darker of the two for its rock and the
    // lighter for its torchlight, so that in a dark theme, where the ink is the lighter colour, the
    // rock stays dark and the torches bright.
    const readColours = () => {
      const style = getComputedStyle(element);
      const [ink, paper] = [rgb(context, style.color), rgb(context, style.backgroundColor)];
      const lighter = luminance(ink) > luminance(paper);
      colours = { ink, paper, dark: lighter ? paper : ink, light: lighter ? ink : paper };
      paint();
    };
    const step = (now: number) => {
      tick = requestAnimationFrame(step);
      if (!visible || now - last < 1000 / FPS) return;
      const seconds = last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      scene.time += seconds;
      scene.walk = advance(scene.walk, seconds);
      scene.shift += (target - scene.shift) * 0.15;
      paint();
    };
    const point = (event: PointerEvent) => {
      const at = element.getBoundingClientRect();
      target = clamp(((event.clientX - at.left) / at.width) * 2 - 1, -1, 1);
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    const sized = new ResizeObserver(fit);
    readColours();
    fit();
    scheme.addEventListener('change', readColours);
    seen.observe(element);
    sized.observe(box);
    if (playing) {
      element.addEventListener('pointermove', point);
      tick = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(tick);
      element.removeEventListener('pointermove', point);
      scheme.removeEventListener('change', readColours);
      seen.disconnect();
      sized.disconnect();
    };
  }, [playing]);

  return (
    <div ref={frame} className={styles.scene}>
      <canvas
        ref={canvas}
        className={styles.canvas}
        width={MIN_WIDTH}
        height={HEIGHT}
        role="img"
        aria-label="A pixel scholar walks through a cave from station to station, a torch over each: a screen for slides, a bookshelf for reading, an easel for exercises, a terminal for notebooks and an hourglass for tests."
      />
      <button type="button" className={styles.toggle} onClick={() => setPlaying(!playing)}>
        {playing ? 'Pause animation' : 'Play animation'}
      </button>
    </div>
  );
}
