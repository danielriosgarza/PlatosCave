import type { InteractiveKind } from '@parallax/contracts';

/**
 * The fields a new interactive step starts with in the editor, as YAML: a small working example
 * of each kind, written as an author would write it in a course file
 * (`docs/guide/exercises.md`). Title, prompt, hints and solution have their own fields.
 */
export const interactiveTemplates: Record<InteractiveKind, string> = {
  categorize: `categories:
  - { id: discrete, label: Discrete }
  - { id: continuous, label: Continuous }
items:
  - { id: die, label: Score on a die, category: discrete }
  - { id: height, label: Height of a person, category: continuous }
  - { id: children, label: Number of children, category: discrete }
  - { id: time, label: Time to run 100 m, category: continuous }
marks: true
feedback:
  correct: Every variable is in its group.
  incorrect: Some variables are not in their group yet.
`,
  fill_blanks: `text: The mean of 2, 4 and 9 is [[mean]] and the median is [[median]].
gaps:
  - { id: mean, answer: five }
  - { id: median, answer: four }
tiles:
  - { id: four, label: "4" }
  - { id: five, label: "5" }
  - { id: nine, label: "9" }
marks: true
feedback:
  correct: Right.
  incorrect: The mean is the total divided by the count; the median is the middle value.
`,
  label_diagram: `scene:
  x: [0, 10]
  y: [0, 4]
  description: A box plot with whiskers from 1 to 9, a box from 3 to 6 and a line at 4.5.
  shapes:
    - { type: segment, from: [1, 2], to: [3, 2] }
    - { type: rect, at: [3, 1], size: [3, 2], fill: soft }
    - { type: segment, from: [4.5, 1], to: [4.5, 3], weight: thick }
    - { type: segment, from: [6, 2], to: [9, 2] }
targets:
  - { id: median, at: [4.5, 3.6], answer: median }
  - { id: lower, at: [3, 0.4], answer: lower }
  - { id: top, at: [9, 2.7], answer: maximum }
labels:
  - { id: median, label: Median }
  - { id: lower, label: Lower quartile }
  - { id: maximum, label: Maximum }
  - { id: mean, label: Mean }
marks: true
feedback:
  correct: Every part of the box plot is labelled.
  incorrect: Some labels are not in place yet.
`,
  plot_points: `scene:
  x: [-5, 5]
  y: [-5, 5]
  axes: { x: x, y: y }
  grid: 1
points:
  - { id: a, label: A, answer: [2, 3] }
  - { id: b, label: B, answer: [-3, -1] }
snap: 1
marks: true
feedback:
  correct: Both points are in place.
  incorrect: Go along the x axis first, then up or down.
`,
  sketch_graph: `scene:
  x: [-3, 3]
  y: [-1, 9]
  axes: { x: x, y: y }
  grid: 1
answer: x^2
samples: { from: -3, to: 3, count: 13 }
tolerance: 0.75
marks: true
feedback:
  correct: That is the shape of y = x².
  incorrect: Not yet. The curve is lowest at x = 0 and rises as fast on each side.
`,
  hotspot: `scene:
  x: [0, 10]
  y: [0, 6]
  axes: true
  description: A histogram with four bars of heights 1, 3, 5 and 2.
  shapes:
    - { type: rect, at: [1, 0], size: [2, 1], fill: soft }
    - { type: rect, at: [3, 0], size: [2, 3], fill: soft }
    - { type: rect, at: [5, 0], size: [2, 5], fill: soft }
    - { type: rect, at: [7, 0], size: [2, 2], fill: soft }
regions:
  - { id: b1, label: First bar, shape: { type: rect, at: [1, 0], size: [2, 1] } }
  - { id: b2, label: Second bar, shape: { type: rect, at: [3, 0], size: [2, 3] } }
  - { id: b3, label: Third bar, shape: { type: rect, at: [5, 0], size: [2, 5] } }
  - { id: b4, label: Fourth bar, shape: { type: rect, at: [7, 0], size: [2, 2] } }
correct: [b3]
feedback:
  correct: The tallest bar holds the mode.
  incorrect: The mode is the class with the most values.
`,
  grid: `rows: 4
cols: 5
answer: { count: 15 }
feedback:
  correct: 15 of 20 cells is three quarters.
  incorrect: Three quarters of 20 cells is 15 cells.
`,
  manipulate: `params:
  - { name: m, label: Slope, min: -3, max: 3, step: 0.5, initial: 0 }
  - { name: c, label: Intercept, min: -4, max: 4, step: 1, initial: 0 }
scene:
  x: [-5, 5]
  y: [-5, 5]
  axes: true
  grid: 1
  shapes:
    - { type: function, y: m*x + c, weight: thick }
    - { type: point, at: [0, 3], tone: muted, label: "(0, 3)" }
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
`,
  explore: `params:
  - { name: a, label: Amplitude, min: 0.5, max: 3, step: 0.1, initial: 1 }
  - { name: k, label: Frequency, min: 0.5, max: 3, step: 0.1, initial: 1, animate: { seconds: 6 } }
scene:
  x: [-6.3, 6.3]
  y: [-3.5, 3.5]
  axes: true
  shapes:
    - { type: function, y: a*sin(k*x), weight: thick }
feedback:
  saved: Keep the shapes you saw in mind for the next step.
`,
  drawing: `aspect: 1.6
feedback:
  saved: Your drawing is saved for your instructor.
`,
};
