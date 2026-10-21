import { describe, expect, it } from 'vitest';
import { type ExerciseStep, exerciseProblems, exerciseStep, exerciseStepView } from './exercise';
import { judge, parseResponse, revealOf, savedByComplete, viewStep } from './exerciseRules';
import { iconName, iconNames, iconSuggestions } from './icons';

const feedback = { correct: 'Right.', incorrect: 'Not yet.' };
const step = (raw: Record<string, unknown>): ExerciseStep =>
  exerciseStep.parse({ id: 's', title: 'Step', prompt: 'Answer.', feedback, ...raw });
const problems = (raw: Record<string, unknown>) =>
  exerciseProblems({
    schema: 'exercise.v1',
    steps: [{ id: 's', title: 'Step', prompt: 'Answer.', feedback, ...raw }],
  });
/** Parses and judges a response as the server does on a check. */
const check = (s: ExerciseStep, response: unknown) => {
  const parsed = parseResponse(s, response);
  if (!parsed.ok) return { refused: parsed.message };
  return judge(s, parsed.value);
};
const plane = { x: [-5, 5], y: [-5, 5], axes: true, grid: 1 };

const sort = step({
  kind: 'categorize',
  categories: [
    { id: 'counted', label: 'Counted' },
    { id: 'measured', label: 'Measured' },
  ],
  items: [
    { id: 'goals', label: 'Goals', category: 'counted' },
    { id: 'height', label: 'Height', category: 'measured', feedback: 'A height is measured.' },
    { id: 'time', label: 'Time', category: 'measured' },
  ],
  marks: true,
});

describe('interactive steps in exercise.v1', () => {
  it('A42 names the field of each cross-field problem', () => {
    expect(
      problems({
        kind: 'categorize',
        categories: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        items: [
          { id: 'x', label: 'X', category: 'a' },
          { id: 'y', label: 'Y', category: 'c' },
        ],
      }),
    ).toEqual(['Step 1 “Step” · items · #2 · category: names no category (c)']);
    expect(
      problems({
        kind: 'fill_blanks',
        text: 'The [[a]] and [[b]].',
        gaps: [{ id: 'a', answer: 't1' }],
        tiles: [{ id: 't1', label: 'one' }],
      }),
    ).toEqual(['Step 1 “Step” · text: [[b]] names no gap']);
    expect(
      problems({
        kind: 'plot_points',
        scene: plane,
        points: [{ id: 'p', label: 'P', answer: [0.3, 1] }],
        snap: 1,
      }),
    ).toEqual([
      'Step 1 “Step” · points · #1 · answer: no position a point can reach is within tolerance of it: use a multiple of snap or a larger tolerance',
    ]);
    expect(
      problems({
        kind: 'sketch_graph',
        scene: plane,
        answer: 'x^3',
        samples: { from: -2, to: 2, count: 5 },
        tolerance: 0.5,
      }),
    ).toEqual(['Step 1 “Step” · answer: leaves the scene at x = -2, so it cannot be drawn there']);
    expect(
      problems({
        kind: 'hotspot',
        scene: plane,
        regions: [
          { id: 'a', label: 'A', shape: { type: 'circle', center: [0, 0], r: 1 } },
          { id: 'b', label: 'B', shape: { type: 'rect', at: [1, 1], size: [1, 1] } },
        ],
        correct: ['a', 'b'],
      }),
    ).toEqual(['Step 1 “Step” · correct: names one region, or set multiple: true']);
    expect(
      problems({
        kind: 'grid',
        rows: 2,
        cols: 2,
        answer: {
          cells: [
            [1, 1],
            [3, 1],
          ],
        },
      }),
    ).toEqual(['Step 1 “Step” · answer · cells · #2: lies outside the 2 × 2 grid']);
    expect(
      problems({
        kind: 'manipulate',
        params: [{ name: 'm', label: 'Slope', min: -3, max: 3, step: 1, initial: 0 }],
        scene: { ...plane, shapes: [{ type: 'function', y: 'm*x + c' }] },
        target: ['near(m, 2, 0.01)'],
        answer: { m: 1 },
      }),
    ).toEqual([
      'Step 1 “Step” · scene · shapes · #1 · y: “m*x + c” uses c, which is not defined here (defined: m, x)',
    ]);
    expect(
      problems({
        kind: 'manipulate',
        params: [{ name: 'm', label: 'Slope', min: -3, max: 3, step: 1, initial: 0 }],
        scene: plane,
        target: ['near(m, 2, 0.01)'],
        answer: { m: 1 },
      }),
    ).toEqual(['Step 1 “Step” · answer: does not meet the target near(m, 2, 0.01)']);
  });

  it('A42 accepts a plotting or sketching step only when a student can reach its answer', () => {
    // The multiples of 4 inside [1, 7] are 4 alone: an answer of 1 is 3 from any place.
    const line = {
      kind: 'plot_points',
      scene: { x: [1, 7], y: [-1, 1] },
      line: true,
      points: [{ id: 'a', label: 'A', answer: 1 }],
      snap: 4,
      tolerance: 1.5,
    };
    expect(problems(line)).toEqual([
      'Step 1 “Step” · points · #1 · answer: no position a point can reach is within tolerance of it: use a multiple of snap or a larger tolerance',
    ]);
    expect(problems({ ...line, tolerance: 3 })).toEqual([]);
    // Whatever the editor accepts, Show solution's answer is judged right.
    const reachable = step({ ...line, tolerance: 3 });
    expect(check(reachable, revealOf(reachable))).toMatchObject({ correct: true });
    expect(problems({ ...line, scene: { x: [1, 3], y: [-1, 1] } })).toEqual([
      'Step 1 “Step” · snap: leaves no position inside the scene: use a smaller snap',
    ]);
    // An arrow key moves a sketch point by 0.2 on a scene 10 high: 0.05 is out of its reach.
    const sketch = {
      kind: 'sketch_graph',
      scene: { x: [0, 4], y: [0, 10] },
      answer: '0.5*x + 1',
      samples: { from: 0, to: 4, count: 5 },
      tolerance: 0.05,
    };
    expect(problems(sketch)).toEqual([
      'Step 1 “Step” · tolerance: must be at least 0.1, half the 0.2 an arrow key moves a point, or the keyboard cannot reach the curve',
    ]);
    expect(problems({ ...sketch, tolerance: 0.1 })).toEqual([]);
    // At that least tolerance, the curves the arrow keys reach on either side of the answer are
    // right, though each lies 0.1 from it only up to rounding.
    const keyed = (target: number, above: boolean) => {
      let y = 0;
      while (y + 0.2 <= target + 1e-9) y = Number((y + 0.2).toFixed(6));
      return above && y < target ? Number((y + 0.2).toFixed(6)) : y;
    };
    const least = step({ ...sketch, tolerance: 0.1 });
    for (const above of [false, true]) {
      const ys = [0, 1, 2, 3, 4].map((x) => keyed(0.5 * x + 1, above));
      expect(check(least, ys), String(ys)).toMatchObject({ correct: true });
    }
    // On a scene 0.04 high a press moves a point by 0.001, the least a height is read out by.
    const short = { ...sketch, scene: { x: [0, 4], y: [0, 0.04] }, answer: '0.01*x' };
    expect(problems({ ...short, tolerance: 0.0005 })).toEqual([]);
    expect(problems({ ...short, tolerance: 0.0001 })).toEqual([
      'Step 1 “Step” · tolerance: must be at least 0.0005, half the 0.001 an arrow key moves a point, or the keyboard cannot reach the curve',
    ]);
    expect(
      problems({
        ...short,
        scene: { x: [0, 4], y: [0, 0.03] },
        answer: '0.005*x',
        tolerance: 0.01,
      }),
    ).toEqual([]);
    expect(
      problems({
        ...short,
        scene: { x: [0, 4], y: [0, 0.01] },
        answer: '0.002*x',
        tolerance: 0.01,
      }),
    ).toEqual([
      'Step 1 “Step” · scene · y: spans too little to sketch on: use larger units, so that it is at least 0.04 high',
    ]);
  });

  it('A08 sends a student no answer: the view of each kind holds no key, target or tolerance', () => {
    const manipulate = step({
      kind: 'manipulate',
      params: [{ name: 'm', label: 'Slope', min: -3, max: 3, step: 1, initial: 0 }],
      scene: plane,
      target: ['near(m, 2, 0.01)'],
      answer: { m: 2 },
      feedback: { ...feedback, rules: [{ when: 'm > 2', say: 'Too steep.' }] },
    });
    const hotspot = step({
      kind: 'hotspot',
      scene: plane,
      regions: [
        { id: 'a', label: 'A', shape: { type: 'circle', center: [0, 0], r: 1 }, feedback: 'No.' },
        { id: 'b', label: 'B', shape: { type: 'rect', at: [1, 1], size: [1, 1] } },
      ],
      correct: ['b'],
    });
    const secrets: [ExerciseStep, string[]][] = [
      [sort, ['category', 'A height is measured', 'Right.']],
      [manipulate, ['near(m', 'target', 'answer', 'Too steep']],
      [hotspot, ['correct', 'No.']],
    ];
    for (const [s, words] of secrets) {
      const view = JSON.stringify(exerciseStepView.parse(viewStep(s, 7)));
      for (const word of words) expect(view, `${s.kind}: ${word}`).not.toContain(word);
    }
  });
});

describe('judging interactive steps', () => {
  it('A08 marks each part of a sorting and gives the misplaced item’s feedback', () => {
    expect(check(sort, { goals: 'counted', height: 'counted' })).toEqual({
      refused: 'Place every item in a group',
    });
    expect(check(sort, { goals: 'counted', height: 'counted', time: 'measured' })).toEqual({
      correct: false,
      feedback: 'A height is measured.',
      parts: { goals: true, height: false, time: true },
    });
    expect(check(sort, revealOf(sort))).toMatchObject({ correct: true, feedback: 'Right.' });
  });

  it('A08 reads typed gaps without regard to case and spacing, and numbers within tolerance', () => {
    const typed = step({
      kind: 'fill_blanks',
      text: 'The mean is [[mean]] and the middle is the [[name]].',
      gaps: [
        { id: 'mean', number: 6, tolerance: 0.05 },
        { id: 'name', accept: ['median'] },
      ],
    });
    expect(check(typed, { mean: '6,0', name: '  MEDIAN ' })).toMatchObject({ correct: true });
    expect(check(typed, { mean: '6.1', name: 'median' })).toMatchObject({ correct: false });
    expect(check(typed, { mean: '', name: 'median' })).toEqual({ refused: 'Fill every gap' });
  });

  it('A08 refuses a tile used twice and deals interchangeable tiles when revealing', () => {
    const tiles = step({
      kind: 'fill_blanks',
      text: '[[a]] and [[b]]',
      gaps: [
        { id: 'a', answer: ['x', 'y'] },
        { id: 'b', answer: ['x', 'y'] },
      ],
      tiles: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
        { id: 'z', label: 'Z' },
      ],
    });
    expect(check(tiles, { a: 'x', b: 'x' })).toEqual({ refused: 'Use each tile once' });
    expect(check(tiles, { a: 'y', b: 'x' })).toMatchObject({ correct: true });
    const dealt = revealOf(tiles) as Record<string, string>;
    expect(new Set(Object.values(dealt)).size).toBe(2);
    expect(check(tiles, dealt)).toMatchObject({ correct: true });
  });

  it('A08 judges plotted points within tolerance, unordered points by a matching, and only reachable positions', () => {
    const points = step({
      kind: 'plot_points',
      scene: plane,
      points: [
        { id: 'a', label: 'A', answer: [1, 1] },
        { id: 'b', label: 'B', answer: [2, 2] },
      ],
      snap: 0.5,
      unordered: true,
      marks: true,
    });
    expect(check(points, { a: [2, 2], b: [1, 1] })).toMatchObject({ correct: true });
    // Both points on one answer: each is near an answer, but one answer is left unmet.
    expect(check(points, { a: [1, 1], b: [1, 1] })).toEqual({
      correct: false,
      feedback: 'Not yet.',
      parts: { a: true, b: true },
    });
    expect(check(points, { a: [1.25, 1], b: [2, 2] })).toEqual({
      refused: 'A point is off the scene',
    });
    const line = step({
      kind: 'plot_points',
      scene: { x: [0, 10], y: [-1, 1] },
      line: true,
      points: [{ id: 'm', label: 'Mean', answer: 4.2 }],
      snap: 0.5,
      tolerance: 0.3,
    });
    // The revealed answer is a position the learner can reach, within the tolerance.
    expect(revealOf(line)).toEqual({ m: [4, 0] });
    expect(check(line, revealOf(line))).toMatchObject({ correct: true });
  });

  it('A08 marks a sketch sample by sample against the curve', () => {
    const sketch = step({
      kind: 'sketch_graph',
      scene: { x: [-2, 2], y: [-1, 5] },
      answer: 'x^2',
      samples: { from: -2, to: 2, count: 5 },
      tolerance: 0.5,
      marks: true,
    });
    expect(check(sketch, [4, 1, 0, 1, 4])).toMatchObject({ correct: true });
    expect(check(sketch, [4, 1, 0, 1, 2])).toEqual({
      correct: false,
      feedback: 'Not yet.',
      parts: { 0: true, 1: true, 2: true, 3: true, 4: false },
    });
    expect(check(sketch, [4, 1, 0])).toEqual({ refused: 'Draw the curve across the whole range' });
    expect(check(sketch, revealOf(sketch))).toMatchObject({ correct: true });
  });

  it('A08 needs every correct region, and gives a wrongly chosen region’s feedback', () => {
    const regions = step({
      kind: 'hotspot',
      scene: plane,
      regions: [
        { id: 'a', label: 'A', shape: { type: 'circle', center: [0, 0], r: 1 } },
        { id: 'b', label: 'B', shape: { type: 'rect', at: [1, 1], size: [1, 1] } },
        {
          id: 'c',
          label: 'C',
          shape: {
            type: 'polygon',
            points: [
              [-3, -3],
              [-2, -3],
              [-2, -2],
            ],
          },
          feedback: 'C is below the line.',
        },
      ],
      correct: ['a', 'b'],
      multiple: true,
    });
    expect(check(regions, ['a'])).toMatchObject({ correct: false, feedback: 'Not yet.' });
    expect(check(regions, ['a', 'b', 'c'])).toMatchObject({
      correct: false,
      feedback: 'C is below the line.',
    });
    expect(check(regions, ['b', 'a'])).toMatchObject({ correct: true });
    expect(check(regions, ['a', 'a'])).toEqual({ refused: 'Choose each region at most once' });
  });

  it('A08 counts shaded cells, fixed ones included, and refuses a fixed cell sent again', () => {
    const grid = step({
      kind: 'grid',
      rows: 2,
      cols: 3,
      fixed: [[1, 1]],
      answer: { count: 3 },
    });
    expect(
      check(grid, [
        [2, 2],
        [2, 3],
      ]),
    ).toMatchObject({ correct: true });
    expect(check(grid, [[2, 2]])).toMatchObject({ correct: false });
    expect(
      check(grid, [
        [1, 1],
        [2, 2],
      ]),
    ).toEqual({ refused: 'Shade cells of the grid, each once' });
    expect(check(grid, revealOf(grid))).toMatchObject({ correct: true });
  });

  it('A08 checks a manipulation against its target and gives the first rule that holds', () => {
    const slope = step({
      kind: 'manipulate',
      params: [
        {
          kind: 'point',
          name: 'P',
          label: 'P',
          x: [-4, 4],
          y: [-4, 4],
          step: 0.5,
          initial: [1, 1],
        },
        { name: 'k', label: 'k', min: 0, max: 2, step: 0.5, initial: 1 },
      ],
      scene: {
        ...plane,
        shapes: [
          {
            type: 'line',
            through: [
              [0, 0],
              ['P.x', 'P.y'],
            ],
          },
        ],
      },
      target: ['P.x != 0', 'near(P.y, 2 * P.x * k, 0.01)'],
      answer: { P: [1, 2], k: 1 },
      feedback: { ...feedback, rules: [{ when: 'P.y < P.x', say: 'P is below y = x.' }] },
    });
    expect(check(slope, { P: [2, 4], k: 1 })).toEqual({ correct: true, feedback: 'Right.' });
    expect(check(slope, { P: [2, 1], k: 1 })).toEqual({
      correct: false,
      feedback: 'P is below y = x.',
    });
    expect(check(slope, { P: [1, 1], k: 1 })).toEqual({ correct: false, feedback: 'Not yet.' });
    expect(check(slope, { P: [1.25, 1], k: 1 })).toEqual({
      refused: 'A value is outside its control’s range',
    });
    expect(check(slope, { P: [1, 2] })).toEqual({
      refused: 'A value is outside its control’s range',
    });
    expect(check(slope, revealOf(slope))).toMatchObject({ correct: true });
  });

  it('A07 saves a drawing with strokes or a description alone, and never grades it', () => {
    const drawing = step({ kind: 'drawing', feedback: { saved: 'Saved for review.' } });
    expect(savedByComplete(drawing)).toBe(true);
    expect(check(drawing, { strokes: [], description: '' })).toEqual({
      refused: 'Draw something or describe your drawing first',
    });
    expect(check(drawing, { strokes: [], description: 'A falling line of points.' })).toEqual({
      correct: true,
      feedback: 'Saved for review.',
    });
    const stroke = {
      tool: 'pen',
      color: '#202124',
      width: 4,
      points: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    };
    expect(check(drawing, { strokes: [stroke], description: '' })).toMatchObject({ correct: true });
    expect(revealOf(drawing)).toBeNull();
  });
});

describe('icons in interactive steps', () => {
  const lunch = {
    kind: 'categorize',
    iconsOnly: true,
    categories: [
      { id: 'fruit', label: 'Fruit', icon: 'apple' },
      { id: 'drink', label: 'Drink' },
    ],
    items: [
      { id: 'banana', label: 'Banana', icon: 'banana', category: 'fruit' },
      { id: 'milk', label: 'Milk', icon: 'milk', category: 'drink', feedback: 'Milk is drunk.' },
    ],
  };

  it('A42 names an unknown icon with the nearest names, and reads capitals as small letters', () => {
    expect(iconNames.size).toBeGreaterThan(1500);
    expect(iconSuggestions('tree')).toEqual(['tree-palm', 'tree-pine', 'tree-deciduous']);
    expect(iconSuggestions('sqare')[0]).toBe('square');
    expect(
      problems({
        kind: 'hotspot',
        scene: { ...plane, shapes: [{ type: 'icon', name: 'Tree-Pine', at: [0, 0] }] },
        regions: [
          { id: 'a', label: 'A', shape: { type: 'icon', name: 'triangel', at: [1, 1] } },
          { id: 'b', label: 'B', shape: { type: 'icon', name: 'Circle', at: [3, 1] } },
        ],
        correct: ['a'],
      }),
    ).toEqual([
      'Step 1 “Step” · regions · #1 · shape · name: is not an icon: try triangle (the icons are listed at lucide.dev/icons)',
    ]);
    expect(
      problems({
        ...lunch,
        categories: [{ id: 'fruit', label: 'Fruit', icon: 'xyzzy' }, lunch.categories[1]],
      }),
    ).toEqual([
      'Step 1 “Step” · categories · #1 · icon: is not an icon (the icons are listed at lucide.dev/icons)',
    ]);
    const parsed = step({
      kind: 'manipulate',
      params: [{ name: 'n', label: 'N', min: 0, max: 3, step: 1, initial: 0 }],
      scene: { ...plane, shapes: [{ type: 'icon', name: ' User ', at: [0, 0] }] },
      target: ['n == 2'],
    });
    expect(parsed.kind === 'manipulate' && parsed.scene.shapes[0]).toMatchObject({ name: 'user' });
  });

  it('A42 reads Lucide’s older names as the icons they name, and refuses a long name at once', () => {
    expect(iconName.parse('home')).toBe('house');
    expect(iconName.parse('Alert-Circle')).toBe('circle-alert');
    expect(iconSuggestions('hom')[0]).toBe('house');
    const longest = [...iconNames].reduce((a, b) => (b.length > a.length ? b : a));
    expect(iconName.parse(longest)).toBe(longest);
    // However long the name, refusing it is quick: it is longer than any icon's.
    const started = performance.now();
    const refused = iconName.safeParse('a'.repeat(1_000_000));
    expect(performance.now() - started).toBeLessThan(200);
    expect(refused.error?.issues[0]?.message).toBe(
      'is not an icon (the icons are listed at lucide.dev/icons)',
    );
    expect(iconSuggestions('a'.repeat(longest.length + 1))).toEqual([]);
    const sized = (size: unknown) =>
      problems({
        kind: 'manipulate',
        params: [{ name: 'n', label: 'N', min: 0, max: 3, step: 1, initial: 0 }],
        scene: { ...plane, shapes: [{ type: 'icon', name: 'user', at: [0, 0], size }] },
        target: ['n == 2'],
      });
    expect(sized(0)).toEqual([
      'Step 1 “Step” · scene · shapes · #1 · size: must be greater than 0',
    ]);
    expect(sized('n + 1')).toEqual([]);
  });

  it('A42 needs an icon on every piece of an iconsOnly step, and tiles for one with gaps', () => {
    expect(problems(lunch)).toEqual([]);
    expect(
      problems({
        ...lunch,
        items: [lunch.items[0], { id: 'milk', label: 'Milk', category: 'drink' }],
      }),
    ).toEqual([
      'Step 1 “Step” · items · #2 · icon: is missing: with iconsOnly, each piece is shown by its icon',
    ]);
    expect(
      problems({
        kind: 'fill_blanks',
        iconsOnly: true,
        text: 'An [[a]] a day.',
        gaps: [{ id: 'a', accept: ['apple'] }],
      }),
    ).toEqual([
      'Step 1 “Step” · iconsOnly: shows tiles by their icons, and this step has no tiles',
    ]);
    expect(
      problems({
        kind: 'label_diagram',
        iconsOnly: true,
        scene: plane,
        targets: [{ id: 't', at: [0, 0], answer: 'sun' }],
        labels: [
          { id: 'sun', label: 'Sun', icon: 'sun' },
          { id: 'moon', label: 'Moon' },
        ],
      }),
    ).toEqual([
      'Step 1 “Step” · labels · #2 · icon: is missing: with iconsOnly, each piece is shown by its icon',
    ]);
  });

  it('A42 reads an icon’s place, size and turn as expressions over the parameters', () => {
    const scene = (shape: Record<string, unknown>) => ({
      kind: 'manipulate',
      params: [{ name: 'n', label: 'N', min: 0, max: 3, step: 1, initial: 0 }],
      scene: { ...plane, shapes: [{ type: 'icon', name: 'user', at: ['i', 0], ...shape }] },
      target: ['n == 2'],
    });
    expect(
      problems(scene({ size: '0.5 + n / 4', rotate: '30 * i', each: { name: 'i', count: 'n' } })),
    ).toEqual([]);
    expect(problems(scene({ size: 'k', rotate: 'q', each: { name: 'i', count: 'n' } }))).toEqual([
      'Step 1 “Step” · scene · shapes · #1 · size: “k” uses k, which is not defined here (defined: i, n)',
      'Step 1 “Step” · scene · shapes · #1 · rotate: “q” uses q, which is not defined here (defined: i, n)',
    ]);
  });

  it('A08 sends the pieces’ icons, and still no answer', () => {
    const sorting = exerciseStepView.parse(viewStep(step(lunch), 7)).interactive;
    expect(sorting).toMatchObject({
      kind: 'categorize',
      iconsOnly: true,
      categories: [
        { id: 'fruit', label: 'Fruit', icon: 'apple' },
        { id: 'drink', label: 'Drink' },
      ],
    });
    expect(sorting?.kind === 'categorize' && sorting.items).toEqual(
      expect.arrayContaining([
        { id: 'banana', label: 'Banana', icon: 'banana' },
        { id: 'milk', label: 'Milk', icon: 'milk' },
      ]),
    );
    const plotting = step({
      kind: 'plot_points',
      scene: plane,
      points: [{ id: 'tent', label: 'Tent', icon: 'tent', answer: [2, 3] }],
      snap: 1,
    });
    const plotted = exerciseStepView.parse(viewStep(plotting, 7)).interactive;
    expect(plotted?.kind === 'plot_points' && plotted.points).toEqual([
      { id: 'tent', label: 'Tent', icon: 'tent' },
    ]);
    for (const [s, words] of [
      [step(lunch), ['category', 'Milk is drunk']],
      [plotting, ['answer', '[2,3]']],
    ] as const) {
      const view = JSON.stringify(exerciseStepView.parse(viewStep(s, 7)));
      for (const word of words) expect(view, `${s.kind}: ${word}`).not.toContain(word);
    }
    // Without icons, a view is as it was: no icon keys and no iconsOnly.
    expect(JSON.stringify(exerciseStepView.parse(viewStep(sort, 7)))).not.toMatch(/icon/i);
    // A correct sorting of icon pieces is judged as any other.
    expect(check(step(lunch), { banana: 'fruit', milk: 'drink' })).toMatchObject({
      correct: true,
    });
  });
});
