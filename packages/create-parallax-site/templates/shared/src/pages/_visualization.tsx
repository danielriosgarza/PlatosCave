import { useLayoutEffect, useRef, useState } from 'react';
import styles from './_visualization.module.css';

// The scene of the front page: Plato's cave. Prisoners sit chained with their backs to us and
// watch the wall, where the fire behind them throws the shadows of things carried past: a horse,
// a jar, a bird and a statue of a soldier. Everything is drawn here in two colours, the darker
// and the lighter of the page's ink and paper, so the file needs no image. A name that starts
// with `_` makes this file a helper of `index.tsx` and not a page. To change the scene, edit the
// constants below; to replace it, export another component from this file; to remove it, delete
// its import and its element in `index.tsx`.

/** The height of the drawing in scene pixels. Its width is whatever its box holds. */
const HEIGHT = 132;
/** CSS pixels per scene pixel: a whole number, so that every pixel is crisp. */
const pixelFor = (cssWidth: number) => (cssWidth >= 1500 ? 4 : cssWidth >= 600 ? 3 : 2);
/** Where the fire's light on the wall is brightest, as a share of the width and a row. */
const LIGHT = { x: 0.5, y: 70, reach: 0.72 };
/** The row where the parapet behind the prisoners starts to shade the wall, and the floor. */
const PARAPET = 111;
const FLOOR = 117;
/** The row on which the carried things travel, their size, their speed in pixels per second and
 * the gap between two of them. */
const PROCESSION = { y: 67, size: 1.1, speed: 11, gap: 140 };
/** The room each prisoner takes along the floor, in pixels: a wider scene seats more of them. */
const SEAT = 64;
/** Frames per second: low on purpose, as on an old handheld. */
const FPS = 30;
/** How far, in pixels, the prisoners and the rock in front shift when the pointer crosses. */
const POINTER_SHIFT = 6;
/** Changes the rock of the ceiling and the sides. */
const SEED = 11;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A number in [0, 1) that depends only on its arguments. */
function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(SEED, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth noise in [0, 1], and the same at several scales. */
function noise(x: number, y: number): number {
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const [u, v] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
  return top + (bottom - top) * v;
}
function fbm(x: number, y: number): number {
  return (noise(x, y) * 4 + noise(x * 2.1, y * 2.1) * 2 + noise(x * 4.3, y * 4.3)) / 7;
}

/** The 8 × 8 ordered dither: a pixel is light where its brightness passes its cell's threshold. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((n) => (n + 0.5) / 64);

/** The lowest row of the ceiling at column `x` of a scene `width` wide: a vault that comes down
 * at both sides, with a row of stalactites along its edge. */
function ceiling(x: number, width: number): number {
  const across = (2 * x) / width - 1;
  let bottom = 2 + across ** 4 * 30 + fbm(x / 30, 3.7) * 5;
  for (let n = Math.floor(x / 11) - 1; n <= Math.floor(x / 11) + 1; n++) {
    const length = 3 + hash(n, 5) ** 1.5 * 11;
    const centre = n * 11 + hash(n, 6) * 5;
    const half = 2 + hash(n, 7) * 2.5;
    const tip = 1 - Math.abs(x - centre) / half;
    if (tip > 0) bottom = Math.max(bottom, 2 + across ** 4 * 30 + length * tip ** 1.4);
  }
  return bottom;
}

/** How far the rock at either side of the cave reaches in at row `y`. */
function side(y: number, width: number, right: boolean): number {
  const reach = Math.min(22, width * 0.06);
  return reach * (0.7 + fbm(y / 24, right ? 31 : 17) * 0.6) + (y / HEIGHT) ** 3 * reach * 0.6;
}

/** The lit wall without shadows, one brightness per pixel; it depends only on the width. */
function wall(width: number): Float32Array<ArrayBuffer> {
  const light = new Float32Array(width * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width * LIGHT.x) / (width * LIGHT.reach);
      const dy = (y - LIGHT.y) / 105;
      let b = 1.12 - (dx * dx + dy * dy) * 1.05;
      // The rock: a faint grain.
      b *= 0.84 + fbm(x / 23, y / 13) * 0.26;
      // The parapet behind the prisoners keeps the light off the foot of the wall.
      b *= 1 - smooth(PARAPET - 4, PARAPET + 3, y + (fbm(x / 13, 9) - 0.5) * 3) * 0.92;
      light[y * width + x] = b;
    }
  }
  return light;
}

type Paint = CanvasRenderingContext2D;

/** A horse walking to the right, its legs at `phase` of a stride. Drawn with its belly at 0, 0. */
function horse(c: Paint, phase: number) {
  c.save();
  c.translate(0, -9);
  // The board its hooves stand on, which the staff holds up.
  c.fillRect(-14, 9, 28, 3);
  c.beginPath();
  c.ellipse(0, -14, 14, 6, 0, 0, Math.PI * 2);
  c.fill();
  // Neck, rising to the head, which hangs forward to the muzzle.
  c.beginPath();
  c.moveTo(7, -19);
  c.quadraticCurveTo(13, -28, 17, -37);
  c.lineTo(21, -38);
  c.lineTo(29, -29);
  c.quadraticCurveTo(30, -26, 27, -26);
  c.lineTo(22, -30);
  c.quadraticCurveTo(19, -22, 13, -10);
  c.closePath();
  c.fill();
  c.beginPath();
  c.moveTo(17, -36);
  c.lineTo(18, -41);
  c.lineTo(20, -37);
  c.fill();
  // Mane and tail.
  c.lineCap = 'round';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(17, -37);
  c.quadraticCurveTo(12, -30, 7, -20);
  c.stroke();
  c.beginPath();
  c.moveTo(-13, -17);
  c.quadraticCurveTo(-20, -15, -20, -4 + Math.sin(phase * Math.PI * 2) * 1.5);
  c.stroke();
  // Legs: the diagonal pairs swing together, and a lifted hoof bends back at the knee.
  c.lineWidth = 2;
  for (const [hip, offset] of [
    [-10, 0],
    [-7, 0.5],
    [8, 0.5],
    [11, 0],
  ] as const) {
    const swing = Math.sin((phase + offset) * Math.PI * 2);
    const lift = Math.max(0, Math.cos((phase + offset) * Math.PI * 2));
    const knee = { x: hip + swing * 3, y: -1 - lift };
    c.beginPath();
    c.moveTo(hip, -12);
    c.lineTo(knee.x, knee.y);
    c.lineTo(knee.x + swing * 2 + lift * (hip < 0 ? 3 : -3), 9 - lift * 3);
    c.stroke();
  }
  c.restore();
}

/** A jar with a lip, a narrow neck, two handles and a foot, rocking a little on its staff. */
function jar(c: Paint, time: number) {
  c.save();
  c.rotate(Math.sin(time * 1.7) * 0.05);
  c.beginPath();
  c.moveTo(-3, -34);
  c.lineTo(3, -34);
  c.lineTo(3, -29);
  c.bezierCurveTo(14, -26, 13, -9, 4, -4);
  c.lineTo(3, -1);
  c.lineTo(6, 0);
  c.lineTo(6, 2);
  c.lineTo(-6, 2);
  c.lineTo(-6, 0);
  c.lineTo(-3, -1);
  c.lineTo(-4, -4);
  c.bezierCurveTo(-13, -9, -14, -26, -3, -29);
  c.closePath();
  c.fill();
  c.fillRect(-6, -37, 12, 3);
  // The handles stand off the neck, so that they show in the shadow.
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * 3, -32);
    c.bezierCurveTo(s * 13, -36, s * 15, -27, s * 9, -23);
    c.stroke();
  }
  c.restore();
}

/** A bird on a perch, beating its wings: up in a V, then down in an arch. */
function bird(c: Paint, time: number) {
  const up = Math.floor(time * 4) % 2 === 0;
  c.fillRect(-8, -1, 16, 3);
  c.fillRect(-1, -6, 2, 6);
  // Body, head and beak, facing the way it is carried.
  c.beginPath();
  c.ellipse(0, -11, 8, 4, -0.15, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.arc(8, -15, 3.4, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(10.5, -16.5);
  c.lineTo(16, -14.5);
  c.lineTo(10.5, -13);
  c.fill();
  // Three tail feathers.
  c.lineWidth = 1.6;
  c.lineCap = 'round';
  for (const lift of [-3, 0, 3]) {
    c.beginPath();
    c.moveTo(-6, -10);
    c.lineTo(-15, -9 + lift);
    c.stroke();
  }
  // The wings, from the shoulder.
  c.lineWidth = 3;
  c.lineJoin = 'round';
  c.beginPath();
  if (up) {
    c.moveTo(-9, -27);
    c.lineTo(-1, -13);
    c.lineTo(5, -28);
  } else {
    c.moveTo(-11, -7);
    c.quadraticCurveTo(-6, -15, -1, -13);
    c.quadraticCurveTo(4, -15, 8, -6);
  }
  c.stroke();
}

/** A statue of a soldier on its plinth: a crested helmet, a round shield and a raised spear. */
function soldier(c: Paint, time: number) {
  c.save();
  c.rotate(Math.sin(time * 2.1) * 0.035);
  c.fillRect(-9, -4, 18, 5);
  c.fillRect(-7, -7, 14, 3);
  // Legs, body and head.
  c.beginPath();
  c.moveTo(-5, -7);
  c.lineTo(-3, -19);
  c.lineTo(3, -19);
  c.lineTo(5, -7);
  c.lineTo(2, -7);
  c.lineTo(0, -15);
  c.lineTo(-2, -7);
  c.closePath();
  c.fill();
  c.beginPath();
  c.moveTo(-5, -19);
  c.lineTo(-6, -32);
  c.lineTo(6, -32);
  c.lineTo(5, -19);
  c.closePath();
  c.fill();
  c.beginPath();
  c.arc(0, -36, 3.6, 0, Math.PI * 2);
  c.fill();
  // The helmet's crest, sweeping back.
  c.beginPath();
  c.moveTo(-1, -39);
  c.quadraticCurveTo(-4, -45, -10, -41);
  c.quadraticCurveTo(-5, -40, -3, -36);
  c.closePath();
  c.fill();
  // The shield on the left arm, the spear in the raised right hand.
  c.beginPath();
  c.arc(-7, -25, 6.5, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(5, -30);
  c.lineTo(10, -38);
  c.stroke();
  c.lineWidth = 1.3;
  c.beginPath();
  c.moveTo(11, -50);
  c.lineTo(9, -12);
  c.stroke();
  c.beginPath();
  c.moveTo(11.2, -55);
  c.lineTo(13.4, -49);
  c.lineTo(9, -49);
  c.fill();
  c.restore();
}

/** The things carried past, in order. Each is drawn at `time`, in seconds. */
const CARRIED: ((c: Paint, time: number) => void)[] = [
  (c, t) => horse(c, t * 1.1),
  jar,
  bird,
  soldier,
];

/** A prisoner seen from behind, sitting: `kind` picks the hair, `look` turns the head aside. */
function prisoner(c: Paint, kind: number, look: number) {
  c.beginPath();
  // Back and shoulders.
  c.moveTo(-12, 40);
  c.quadraticCurveTo(-15, 10, -12, 4);
  c.quadraticCurveTo(-8, 0, -4, -1);
  c.lineTo(4, -1);
  c.quadraticCurveTo(8, 0, 12, 4);
  c.quadraticCurveTo(15, 10, 12, 40);
  c.closePath();
  c.fill();
  // Neck and head; turned, the head shows a brow, a nose and a chin.
  c.fillRect(-3, -6, 6, 7);
  c.beginPath();
  c.ellipse(look * 1.5, -12, 6.2, 7, 0, 0, Math.PI * 2);
  c.fill();
  if (look === 0) {
    c.fillRect(-7, -13, 2, 4);
    c.fillRect(5, -13, 2, 4);
  }
  if (look !== 0) {
    const s = Math.sign(look);
    c.beginPath();
    c.moveTo(s * 5, -15);
    c.lineTo(s * 9, -11);
    c.lineTo(s * 6.5, -10);
    c.lineTo(s * 6, -7);
    c.lineTo(s * 3, -6);
    c.closePath();
    c.fill();
  }
  // Hair: cropped, curly, or tied back.
  if (kind === 1) {
    for (const [x, y] of [
      [-5, -17],
      [-2, -19.5],
      [2, -19.5],
      [5, -17],
    ] as const) {
      c.beginPath();
      c.arc(x + look, y, 2.2, 0, Math.PI * 2);
      c.fill();
    }
  } else if (kind === 2) {
    // Hair tied back, falling down the nape.
    c.beginPath();
    c.ellipse(0, -14, 6.6, 5.5, 0, Math.PI, 0);
    c.fill();
    c.fillRect(-1.5, -10, 3, 9);
    c.beginPath();
    c.arc(0, -1, 2.2, 0, Math.PI * 2);
    c.fill();
  }
}

interface Frame {
  width: number;
  time: number;
  /** The pointer, from -1 at the left to 1 at the right. */
  shift: number;
}

/** Where the fire burns: in the middle, nearest of all, so it moves most with the pointer. */
const fireAt = ({ width, shift }: Frame) => Math.round(width / 2 - shift * POINTER_SHIFT * 1.6);

/** Draws the shadows into `shade`: the alpha of each pixel is how much light it loses. */
function shadows(shade: Paint, { width, time }: Frame) {
  shade.clearRect(0, 0, width, HEIGHT);
  shade.save();
  // The flame never holds still, so neither do the shadows.
  const flicker = Math.sin(time * 9.1) * 0.35 + Math.sin(time * 23.3) * 0.25;
  shade.filter = 'blur(0.6px)';
  shade.fillStyle = '#000';
  shade.strokeStyle = '#000';
  shade.translate(flicker * 0.6, flicker * 0.3);
  const loop = CARRIED.length * PROCESSION.gap;
  CARRIED.forEach((draw, i) => {
    const x = ((time * PROCESSION.speed + i * PROCESSION.gap) % loop) - 40;
    if (x < -40 || x > width + 40) return;
    // The bearer walks, so the thing on the staff bobs at each step.
    const bob = Math.abs(Math.sin(time * 3.2 + i)) * 1.5;
    shade.save();
    shade.translate(x, PROCESSION.y - bob);
    shade.scale(PROCESSION.size, PROCESSION.size);
    // The staff, down to the foot of the wall: the prisoners' heads hide part of it.
    shade.lineWidth = 1.8;
    shade.beginPath();
    shade.moveTo(0, 0);
    shade.lineTo(-0.5, HEIGHT);
    shade.stroke();
    draw(shade, time + i * 3.7);
    shade.restore();
  });
  shade.restore();
}

/** Draws the floor, the rock at the sides and the prisoners into `front`. The red channel is the
 * light on them: the floor glows round the fire, and the rest is solid dark. */
function foreground(front: Paint, frame: Frame) {
  const { width, time, shift } = frame;
  const fire = fireAt(frame);
  front.clearRect(0, 0, width, HEIGHT);
  front.fillStyle = '#000';
  front.beginPath();
  front.moveTo(0, HEIGHT);
  for (let x = 0; x <= width; x += 4) front.lineTo(x, FLOOR + fbm(x / 17, 2) * 4);
  front.lineTo(width, HEIGHT);
  front.fill();
  // The fire lights an oval of floor round it.
  const glow = front.createRadialGradient(0, 0, 0, 0, 0, 32);
  glow.addColorStop(0, 'rgb(130,0,0)');
  glow.addColorStop(1, 'rgb(0,0,0)');
  front.save();
  front.globalCompositeOperation = 'source-atop';
  front.translate(fire, HEIGHT - 4);
  front.scale(1, 0.45);
  front.fillStyle = glow;
  front.fillRect(-32, -32, 64, 64);
  front.restore();
  front.fillStyle = '#000';
  // The sides of the cave, close by.
  const rock = shift * POINTER_SHIFT * 1.2;
  for (const right of [false, true]) {
    const [edge, sign] = right ? [width, -1] : [0, 1];
    front.beginPath();
    front.moveTo(edge - sign * 20, 0);
    for (let y = 0; y <= HEIGHT; y += 2)
      front.lineTo(edge + sign * side(y, width, right) - rock, y);
    front.lineTo(edge - sign * 20, HEIGHT);
    front.fill();
  }
  // The prisoners sit on either side of the fire's light, the farther out the nearer to us.
  const room = Math.max(1, Math.round((width * 0.42 - 20) / SEAT));
  for (const sign of [-1, 1]) {
    const necks: [number, number][] = [];
    for (let k = 0; k < room; k++) {
      const x = Math.round(
        width / 2 + sign * (40 + k * SEAT + hash(k, sign + 9) * 8) - shift * POINTER_SHIFT,
      );
      const size = 1.2 + k * 0.12;
      const y = 99 + k * 4;
      // Now and then the one nearest the fire turns from the wall towards the light.
      const cycle = time % 23;
      const look = sign < 0 && k === 0 && cycle > 15 && cycle < 20 ? 1 : 0;
      front.save();
      front.translate(x, y);
      front.scale(size, size);
      prisoner(front, (k + (sign > 0 ? 1 : 0)) % 3, look);
      front.restore();
      necks.push([x, y + 2 * size]);
    }
    // The chain lies along the floor from one prisoner to the next, and catches the firelight.
    front.fillStyle = 'rgb(255,0,0)';
    for (let n = 1; n < necks.length; n++) {
      const [x0, x1] = [necks[n - 1]?.[0] ?? 0, necks[n]?.[0] ?? 0];
      const [from, to] = [Math.min(x0, x1) + 16, Math.max(x0, x1) - 16];
      for (let k = 0; from + k * 2 < to; k++) {
        const x = from + k * 2;
        const t = (x - from) / (to - from);
        const y = Math.round(FLOOR + 6 + Math.sin(t * Math.PI) * 2);
        // Links lying flat and on edge, by turns, in one run.
        if (k % 2) front.fillRect(Math.round(x), y, 2, 1);
        else front.fillRect(Math.round(x), y - 1, 2, 3);
      }
    }
    front.fillStyle = '#000';
  }
}

/** How the fire, low in front of us, lights the pixel at `x`, `y`: 0 outside it, 1 in its three
 * tongues of flame, which sway and leap, and 2 in their hot cores. */
function flame(x: number, y: number, frame: Frame): number {
  const { time } = frame;
  const centre = fireAt(frame);
  let lit = 0;
  for (const [offset, tall, wide, beat] of [
    [-8, 18, 5, 0],
    [0, 28, 7, 1.7],
    [8, 15, 4.5, 3.1],
  ] as const) {
    const height = tall + Math.sin(time * 9 + beat) * 3 + Math.sin(time * 23 + beat) * 2;
    const up = (HEIGHT - 5 - y) / height;
    if (up < 0 || up > 1) continue;
    const away = Math.abs(x - centre - offset - Math.sin(up * 3 - time * 7 + beat) * up * 3);
    const half = wide * (1 - up) ** 0.6;
    if (away < half * 0.45 && up < 0.6) return 2;
    if (away < half) lit = 1;
  }
  return lit;
}

/** The sparks that rise from the fire this frame. */
function sparks(frame: Frame): Set<number> {
  const lit = new Set<number>();
  for (let n = 0; n < 6; n++) {
    const life = 2.2 + hash(n, 21);
    const t = (frame.time + hash(n, 22) * life) % life;
    const x = fireAt(frame) + (hash(n, 23) - 0.5) * 16 + Math.sin(t * 3 + n) * 3;
    const y = HEIGHT - 24 - t * 16;
    lit.add(Math.round(y) * frame.width + Math.round(x));
  }
  return lit;
}

/** Paints one frame into `out`, one byte per pixel: 1 for light, 0 for dark. */
function compose(
  out: Uint8Array,
  lit: Float32Array,
  shade: Uint8ClampedArray,
  front: Uint8ClampedArray,
  frame: Frame,
) {
  const { width, time, shift } = frame;
  const glow = 1 + Math.sin(time * 7.3) * 0.03 + Math.sin(time * 17.9) * 0.025;
  const roof = Math.round(shift * POINTER_SHIFT * 0.5);
  const spark = sparks(frame);
  const fire = fireAt(frame);
  for (let x = 0; x < width; x++) {
    const top = ceiling(x + roof, width);
    for (let y = 0; y < HEIGHT; y++) {
      const i = y * width + x;
      const threshold = BAYER[(y & 7) * 8 + (x & 7)] ?? 0.5;
      const near = y >= HEIGHT - 40 && Math.abs(x - fire) < 24;
      // Two logs cross under the fire.
      const log = near && HEIGHT - y < 6 && Math.abs(Math.abs(x - fire) - (HEIGHT - y) * 2.2) < 2.5;
      const burning = near && !log ? flame(x, y, frame) : 0;
      if (burning) {
        // The tongues are solid, their cores dark.
        out[i] = burning === 1 ? 1 : 0;
      } else if (log) {
        out[i] = 0;
      } else if (
        near &&
        (flame(x - 1, y, frame) ||
          flame(x + 1, y, frame) ||
          flame(x, y + 1, frame) ||
          flame(x, y - 1, frame))
      ) {
        // A dark edge keeps the flame apart from the lit wall behind it.
        out[i] = 0;
      } else if (spark.has(i)) {
        out[i] = 1;
      } else if ((front[i * 4 + 3] ?? 0) > 127) {
        out[i] = (front[i * 4] ?? 0) / 255 > threshold ? 1 : 0;
      } else if (y < top) {
        out[i] = 0;
      } else {
        // A shadow is dark at its core and dithered only at its edge.
        const dark = smooth(0.12, 0.7, (shade[i * 4 + 3] ?? 0) / 255);
        out[i] = (lit[i] ?? 0) * glow * (1 - dark) > threshold ? 1 : 0;
      }
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
  // Kept across a pause, so that the scene goes on where it stopped. It starts with a horse on
  // the wall.
  const state = useRef({ time: 11, shift: 0 });
  const [playing, setPlaying] = useState(
    () =>
      typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useLayoutEffect(() => {
    const box = frame.current;
    const element = canvas.current;
    const context = element?.getContext('2d');
    const layers = [document.createElement('canvas'), document.createElement('canvas')];
    const [shade, front] = layers.map((layer) =>
      layer.getContext('2d', { willReadFrequently: true }),
    );
    if (!box || !element || !context || !shade || !front) return;
    const scene = state.current;
    let [width, lit, pixels, image] = [
      0,
      new Float32Array(0),
      new Uint8Array(0),
      context.createImageData(1, 1),
    ];
    let [target, last, tick] = [scene.shift, 0, 0];
    let visible = true;
    let colours = { dark: [0, 0, 0], light: [255, 255, 255] };

    const paint = () => {
      if (width === 0) return;
      const at: Frame = { width, time: scene.time, shift: scene.shift };
      shadows(shade, at);
      foreground(front, at);
      compose(
        pixels,
        lit,
        shade.getImageData(0, 0, width, HEIGHT).data,
        front.getImageData(0, 0, width, HEIGHT).data,
        at,
      );
      const { data } = image;
      for (let i = 0; i < pixels.length; i++) {
        const colour = pixels[i] ? colours.light : colours.dark;
        data[i * 4] = colour[0] ?? 0;
        data[i * 4 + 1] = colour[1] ?? 0;
        data[i * 4 + 2] = colour[2] ?? 0;
        data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    // The scene is as wide as its box allows at a whole number of CSS pixels per scene pixel.
    const fit = () => {
      // The frame takes four pixels on either side.
      const room = box.clientWidth - 8;
      const scale = pixelFor(room);
      const next = Math.max(1, Math.floor(room / scale));
      element.style.width = `${next * scale}px`;
      if (next === width) return;
      width = next;
      element.width = width;
      for (const layer of layers) [layer.width, layer.height] = [width, HEIGHT];
      lit = wall(width);
      pixels = new Uint8Array(width * HEIGHT);
      image = context.createImageData(width, HEIGHT);
      paint();
    };
    // The stylesheet gives the canvas the page's ink as its colour and paper as its background.
    // The rock is drawn in the darker of the two and the firelight in the lighter, so that the
    // cave stays dark and the fire bright in either theme.
    const readColours = () => {
      const style = getComputedStyle(element);
      const [ink, paper] = [rgb(context, style.color), rgb(context, style.backgroundColor)];
      const lighter = luminance(ink) > luminance(paper);
      colours = { dark: lighter ? paper : ink, light: lighter ? ink : paper };
      paint();
    };
    const step = (now: number) => {
      tick = requestAnimationFrame(step);
      if (!visible || now - last < 1000 / FPS) return;
      const seconds = last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      scene.time += seconds;
      scene.shift += (target - scene.shift) * 0.08;
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
      window.addEventListener('pointermove', point);
      tick = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(tick);
      window.removeEventListener('pointermove', point);
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
        width={160}
        height={HEIGHT}
        role="img"
        aria-label="Plato's cave: chained prisoners, their backs to the fire, watch the shadows of a horse, a jar, a bird and a statue carried across the wall."
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
