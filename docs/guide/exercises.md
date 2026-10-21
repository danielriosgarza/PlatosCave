# Exercise guide

An exercise is a short list of steps (at most 20). This guide is the reference for writing one: in a course folder as a YAML file, or in the browser editor, which shows the same fields. The behaviour is specified in [spec §9](../product-spec.md#9-interactive-exercises). For a working example of every kind, create a site with `npm create parallax-site` and open `exercises/interactive-tour.yaml` in the welcome course (titled **Drag, draw and explore**), or `first-exercise.yaml` beside it.

- [An exercise file](#an-exercise-file)
- [Fields every step has](#fields-every-step-has)
- [Typed and chosen answers](#typed-and-chosen-answers)
- [Interactive steps](#interactive-steps)
- [Scenes](#scenes)
- [Expressions](#expressions)
- [Writing the YAML](#writing-the-yaml)
- [What students and instructors see](#what-students-and-instructors-see)

## An exercise file

```yaml
schema: exercise.v1
steps:
  - id: centre
    title: Plot the centre
    kind: plot_points
    prompt: Drag C to the mean of the points.
    scene: { x: [0, 8], y: [0, 6], axes: true, grid: 1 }
    points:
      - { id: c, label: C, answer: [3, 2] }
    snap: 0.5
    feedback:
      correct: Right. The mean of x is 3 and of y is 2.
      incorrect: Not yet. Average the x values, then the y values.
```

A file that holds answers lies under `private/` when the course is public (see [the course folder](instructors.md)). `parallax check` reads the file with the same rules as the browser editor and names the field of each problem, for example `steps[0].points[0].answer`.

## Fields every step has

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lower-case letters, digits, `-` and `_`; unique in the exercise. |
| `title` | yes | The short name on the step track. |
| `kind` | yes | One of the kinds below. |
| `prompt` | yes | What the student is asked to do. |
| `hints` | no | Up to 10, shown one at a time. Each one shown is recorded. |
| `solution` | no | Shown by **Show solution**, which is recorded. |
| `feedback` | yes | `correct` and `incorrect` for a checked step; `saved` for a saved one. |

Ids (`id` of a step, an item, a category, a gap, a tile, a region and so on) all follow the rule of a step `id`.

**Marks.** Most interactive kinds take `marks: true`. A wrong check then tells the student which parts are right (each item, gap, label, point, sample, chosen region or shaded cell), until the answer changes. Marks are off by default: with few parts, they let a student find the answer by trying.

**Shuffle.** Items, tiles and labels are dealt in an order drawn from the attempt, unless `shuffle: false`.

## Typed and chosen answers

These kinds are typed, chosen or ordered. Each is checked, except `text` and `code`, which are saved.

| Kind | Fields |
| --- | --- |
| `numeric` | `answer`, `tolerance`, `unit`; `feedback` may add `low` and `high`. |
| `single_choice` | `options` (`id`, `label`, `feedback`), `correct` (an option id), `shuffle`. |
| `multiple_choice` | As `single_choice`, with `correct` a list. |
| `ordering` | `items`, `order` (the item ids in order). Students drag the grip or use **Move up** and **Move down**. |
| `matching` | `prompts`, `choices`, `pairs` (prompt id: choice id). |
| `text` | `maxLength`; `feedback.saved`. Saved with **Done**; nothing grades it. |
| `simulation` | `control` (`name`, `label`, `min`, `max`, `step`, `initial`), `observations`, `compare` (values to record); `feedback.correct` and `incomplete`. |
| `code` | `language` (`python` or `r`), `starter`; `feedback.saved`. |

## Interactive steps

In these kinds the student drags, draws or moves things. Every gesture has a keyboard equivalent, which the student view states. The answer stays on the server: the browser receives the pieces and the scene, never the key, a tolerance, a target or a rule.

### Sort into groups: `categorize`

```yaml
kind: categorize
categories:
  - { id: discrete, label: Discrete }
  - { id: continuous, label: Continuous }
items:
  - { id: die, label: Score on a die, category: discrete }
  - id: height
    label: Height of a person
    category: continuous
    feedback: Height can take any value in a range.
marks: true
```

2 to 6 `categories` and 2 to 20 `items`. An item's `feedback` is shown when it is in the wrong group, before `incorrect`. Items and categories may carry an [icon](#icons).

### Fill the gaps: `fill_blanks`

Write each gap in `text` as `[[id]]`, once. With `tiles`, students drag a tile into each gap; without, they type.

```yaml
kind: fill_blanks
text: The mean of 2, 4 and 9 is [[mean]] and the median is [[median]].
gaps:
  - { id: mean, answer: five }
  - { id: median, answer: four }
tiles:
  - { id: four, label: "4" }
  - { id: five, label: "5" }
  - { id: nine, label: "9" }
```

| Field | Meaning |
| --- | --- |
| `gaps[].answer` | With tiles: the tile id, or a list of tile ids any of which fills the gap. |
| `gaps[].accept` | Typed: the answers taken, compared without regard to case and spacing (`caseSensitive: true` to change that). |
| `gaps[].number`, `tolerance` | Typed: a number taken within `tolerance`. A comma is read as a decimal point, and `−` as `-`. |
| `tiles` | Up to 24, distractors included. A tile may carry an [icon](#icons). |
| `reuse` | A tile may fill more than one gap. Without it, the gaps must be fillable with different tiles. |

### Label a diagram: `label_diagram`

A [scene](#scenes) with `targets` (a place `at: [x, y]` and the label `answer`, or a list of labels) and `labels` to drag, distractors included. `reuse` works as for tiles, and a label may carry an [icon](#icons).

```yaml
kind: label_diagram
scene:
  x: [0, 10]
  y: [0, 4]
  description: A box plot with a box from 3 to 6 and a line at 4.5.
  shapes:
    - { type: rect, at: [3, 1], size: [3, 2], fill: soft }
    - { type: segment, from: [4.5, 1], to: [4.5, 3], weight: thick }
targets:
  - { id: median, at: [4.5, 3.6], answer: median }
  - { id: lower, at: [3, 0.4], answer: lower }
labels:
  - { id: median, label: Median }
  - { id: lower, label: Lower quartile }
  - { id: mean, label: Mean }
```

### Plot points: `plot_points`

Students drag points onto the scene, or move them with the arrow keys.

| Field | Meaning |
| --- | --- |
| `points` | Up to 8: `id`, `label`, `answer` (`[x, y]`), `start` (where it is placed; without it the point waits beside the scene) and `icon` (drawn instead of a dot, see [Icons](#icons)). |
| `snap` | Points move in steps of `snap`: each coordinate is a whole multiple of it. |
| `tolerance` | The distance from an answer still accepted (default 0). An answer must be within `tolerance` of a position a point can reach: a multiple of `snap` inside the scene. |
| `unordered` | Any point may stand at any answer, each answer taken once. |
| `line` | A number line: points move along the x axis, and `answer` and `start` are single numbers. |

**Show solution** moves each point to its answer.

### Sketch a graph: `sketch_graph`

Students draw a curve by dragging across the scene, or move each sample with the arrow keys (Page Up and Page Down move ten times as far). The curve is read at `samples` and compared with `answer`, an [expression](#expressions) in `x`.

```yaml
kind: sketch_graph
scene: { x: [-3, 3], y: [-1, 9], axes: { x: x, y: y }, grid: 1 }
answer: x^2
samples: { from: -3, to: 3, count: 13 }
tolerance: 0.75
marks: true
```

`count` is 2 to 41; `start` is the height the curve starts at. The answer must stay inside the scene at every sample. An arrow key moves a point by about a fortieth of the scene's height (0.2 for a height of 10), so `tolerance` must be at least half of that; `parallax check` names the least it can be. The scene must be at least 0.04 high, so each press changes the height read out: for smaller quantities, use larger units.

### Choose regions: `hotspot`

A scene with `regions` the student chooses, by pointer or with the arrow keys and Space. A region's `shape` is a `circle` (`center`, `r`), a `rect` (`at`, `size`), a `polygon` (`points`) or an `icon` (`name`, `at`, `size`, `rotate`: see [Icons](#icons)), in the scene's coordinates; its `label` names it for a screen reader, and its `feedback` is shown when it is chosen wrongly.

```yaml
kind: hotspot
scene:
  x: [0, 10]
  y: [0, 6]
  axes: true
  shapes:
    - { type: rect, at: [1, 0], size: [2, 1], fill: soft }
    - { type: rect, at: [3, 0], size: [2, 5], fill: soft }
regions:
  - { id: b1, label: First bar, shape: { type: rect, at: [1, 0], size: [2, 1] } }
  - { id: b2, label: Second bar, shape: { type: rect, at: [3, 0], size: [2, 5] } }
correct: [b2]
```

With `multiple: true` the student may choose several, and the answer needs every region in `correct` and no other.

### Shade grid cells: `grid`

A grid of `rows` by `cols` (each 1 to 12). Cells are `[row, column]`, counted from 1. `fixed` cells are shaded from the start and locked. The `answer` is either exactly `cells` (fixed ones included) or any `count` cells.

```yaml
kind: grid
rows: 4
cols: 5
fixed: [[1, 1]]
answer: { count: 15 }
```

### Reach a target: `manipulate`

The student moves sliders and handles until every condition of `target` holds. A slider is `name`, `label`, `min`, `max`, `step`, `initial` (and `unit`). A handle is `kind: point`, `name`, `label`, ranges `x` and `y`, `step` and `initial: [x, y]`, and may be drawn as an `icon`; expressions read it as `P.x` and `P.y`. The scene redraws as the values change.

```yaml
kind: manipulate
params:
  - { name: m, label: Slope, min: -3, max: 3, step: 0.5, initial: 0 }
  - { name: c, label: Intercept, min: -4, max: 4, step: 1, initial: 0 }
scene:
  x: [-5, 5]
  y: [-5, 5]
  axes: true
  shapes:
    - { type: function, y: m*x + c, weight: thick }
    - { type: point, at: [2, -1], tone: muted, label: "(2, -1)" }
    - { type: text, at: [-4.8, 4.5], text: "y = {m}x + {c}", align: start }
target:
  - near(m, -2, 0.01)
  - near(c, 3, 0.01)
answer: { m: -2, c: 3 }
feedback:
  correct: y = -2x + 3 passes through both points.
  incorrect: The line must pass through both points.
  rules:
    - { when: "near(c, 3, 0.01)", say: The intercept is right. Now change the slope. }
```

`answer` gives values that meet the target; **Show solution** moves the controls to them. On a wrong check, the first of `feedback.rules` whose `when` holds gives the feedback. Compare measured values with `near(a, b, tolerance)` rather than `==`.

### Explore a scene: `explore`

A scene with sliders and handles, as in `manipulate`, and no target: **Done exploring** completes it. A slider with `animate: { seconds: 6 }` has a **Play** button that runs it from `min` to `max` (and again, unless `loop: false`), through the values the slider offers: a smaller `step` plays more smoothly. `feedback.saved` is optional.

### Freehand drawing: `drawing`

The student draws with a pen and an eraser in five colours and three widths, with undo and redo, and can describe the drawing in words; a description alone is enough to save, so a student who cannot draw can still answer. The drawing is saved for the instructor with **Save drawing**; nothing grades it. `scene` gives something to draw on; without it the sheet is blank, `aspect` wide (default 1.6). `feedback.saved` is required.

## Scenes

A scene is a diagram written as data. Parallax draws it as SVG from the design tokens, so no markup, style, script or address from the file reaches the page.

| Field | Meaning |
| --- | --- |
| `x`, `y` | The ranges shown, `[low, high]`. y points up. |
| `aspect` | Width over height. By default a unit is the same length on both axes, kept between 1:2 and 2.5:1. |
| `axes` | `true` draws the axes through 0; `{ x: name, y: name }` names them. |
| `grid` | `true` for grid lines at the ticks, or a spacing. |
| `ticks` | The spacing of numbered ticks; chosen from the range when absent. |
| `description` | What the scene shows, read by a screen reader. Write it for every scene that carries meaning. |
| `shapes` | Up to 60 shapes, drawn in order. |

| Shape `type` | Fields |
| --- | --- |
| `point` | `at`, `label`, `size` (`small`, `normal`, `large`) |
| `segment` | `from`, `to`, `arrow` (`none`, `end`, `both`), `label` |
| `line` | `through: [[x, y], [x, y]]`, drawn across the whole scene |
| `polygon` | `points`, `closed` (`false` for an open polyline), `fill` |
| `circle` | `center`, `r`, `fill` |
| `rect` | `at` (the lower-left corner), `size: [width, height]`, `fill` |
| `arc` | `center`, `r`, `from`, `to` (degrees, counter-clockwise from the x axis), `sector`, `fill` |
| `function` | `y` (an expression in `x`), `domain` |
| `curve` | `x` and `y` (expressions in `t`), `t: [from, to]` |
| `text` | `at`, `text`, `align` (`start`, `middle`, `end`), `size` |
| `icon` | `name`, `at` (its centre), `size` (its width in x units, more than 0, default 1), `rotate` (degrees, counter-clockwise), `fill`, `label` (written under it): see [Icons](#icons) |

Every shape also takes `tone` (`ink`, `muted`, `faint`), `weight` (`thin`, `normal`, `thick`), `dash: true`, `show` (an expression: the shape is drawn only while it holds) and `each: { name: i, count: n }`, which draws the shape `n` times (at most 200) with `i` = 0, 1, … in its expressions. `fill` is `none`, `soft`, `muted` or `ink`.

Any number in a shape may be an expression over the step's parameters, written as a string: `at: [P.x, "P.y + 1"]`. A `label` or `text` shows a value with `{expression}`, or with `{expression:2}` for two decimals: `"n = {n}"`.

## Icons

Parallax carries the [Lucide](https://lucide.dev/icons) icon set: about 1,900 drawings of objects, animals, foods, plants, vehicles, buildings, people, shapes and signs. A file names an icon as the Lucide site lists it, `name: tree-pine`, and never carries a drawing of its own; Lucide's older names, such as `home` for `house`, are read as the icons they name now. In the browser editor, **Find an icon** under a step's fields searches the icons by name or by what they show and puts the chosen name at the cursor; `parallax check` and the editor suggest the nearest names for a name they do not know (for the first ten such names in an exercise). Icons are drawn in the scene's tones, so they follow the theme.

| Where | How |
| --- | --- |
| In a scene | The shape `type: icon`. Its numbers may be expressions, so an icon moves, turns and grows with the parameters, and `each` repeats it: a pictogram is one shape. |
| On a piece to drag | `icon` on a `categorize` item or category, a `fill_blanks` tile or a `label_diagram` label shows the icon beside the label. With `iconsOnly: true` the pieces show their icons alone, so the picture is the question; each piece then needs an icon, and its label is still what a screen reader says and what a pointer's tooltip shows. |
| As a region | A `hotspot` region with `shape: { type: icon, name, at, size, rotate }`: the student chooses the icon itself. |
| As a point to move | `icon` on a `plot_points` point or a `manipulate` handle draws the icon instead of the dot. |

```yaml
kind: categorize
iconsOnly: true
categories:
  - { id: fruit, label: Fruit, icon: apple }
  - { id: drink, label: Drink, icon: glass-water }
items:
  - { id: banana, label: Banana, icon: banana, category: fruit }
  - { id: coffee, label: Coffee, icon: coffee, category: drink }
```

```yaml
# One shape draws n people in a row.
- { type: icon, name: user, at: ["0.6 + i", 1], size: 0.8, each: { name: i, count: n } }
```

The icons are © Lucide Icons and Contributors under the ISC licence, and those derived from Feather © Cole Bemis under the MIT licence; both licences are kept with Parallax's copy of the icons.

## Expressions

Expressions are read by Parallax itself, the same way in the browser and on the server; they never run as code.

- Numbers, `+ - * / %`, and `^` for powers (`-2^2` is -4).
- Comparisons `< <= > >= == !=`, `&&`, `||`, `!`, and `condition ? a : b`. A comparison gives 1 or 0; a condition holds when it is not 0.
- Constants `pi`, `tau` and `e`.
- Functions: `sin cos tan asin acos atan atan2 sinh cosh tanh sqrt cbrt abs exp ln log10 log2 log(x, base) pow floor ceil trunc round(x) round(x, n) sign min max hypot clamp(x, lo, hi) rad deg near(a, b, tol) between(x, lo, hi)`. Trigonometric functions take radians; `rad(30)` converts.
- Names: the step's parameters (`m`, and `P.x`, `P.y` for a handle `P`), `x` in a `function`, `t` in a `curve`, and the counter of `each`.

A parameter cannot be named after a constant, a function, `x` or `t`. An expression is at most 300 characters. `parallax check` names an unknown name or a missing bracket with the field it is in.

## Writing the YAML

- In a `{ … }` mapping on one line, a comma ends a field. Quote an expression or a sentence that holds a comma: `{ when: "near(c, 3, 0.01)", say: … }`, `label: "(2, -1)"`.
- Quote a label that YAML would read as something else: `"4"` (a number), `"yes"`, a text starting with `{` or `[`.
- `[x, y]` is a pair of numbers; a pair of expressions is `["P.x", "P.y"]`.
- In the editor's fields, anchors and aliases (`&` and `*`) are not accepted; write each value out.

## What students and instructors see

**Students** check an interactive step with **Check answer**, as any other. A wrong answer is kept, so it can be changed and checked again; with `marks: true` the right parts are marked until the answer changes. **Show solution** moves the pieces to the answer, with a short animation unless the student's system asks for reduced motion, and records the step as completed with the solution shown. An exploration is completed with **Done exploring**; a drawing with **Save drawing**.

**Instructors** see each student's final answer drawn as the student saw it, with checked attempts, hints and solutions, under **Review**. A drawing is shown with its description. In the browser editor, an interactive step's fields are written as YAML under **Step n fields (YAML)**, with a live preview in which **Try checking** judges the answer as the server would and **Show the expected answer** moves the pieces into place.
