---
name: "Parallax wireframe"
description: "The visual system observed in the unified course-workspace wireframe."
colors:
  paper: "light-dark(#ffffff,#15171a)"
  sheet: "light-dark(#ffffff,#1b1e23)"
  ink: "light-dark(#202124,#eef0f3)"
  muted: "light-dark(#60646c,#afb5bf)"
  rule: "light-dark(#d9dce1,#3b4048)"
  accent-ink: "light-dark(#ffffff,#202124)"
  highlight: "light-dark(#f7edb1,#534a20)"
  soft: "light-dark(#f1f2f4,#292d34)"
  secondary: "light-dark(#f6f7f8,#1b1e23)"
  success: "light-dark(#315747,#a9cebc)"
typography:
  title:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  subsection:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.65
  ui:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  field:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Segoe UI", Arial, Helvetica, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  code:
    fontFamily: "ui-monospace, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  code-editor:
    fontFamily: "ui-monospace, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  control: "4px"
  passage-tools: "5px"
  note: "6px"
  card: "8px"
  filter: "18px"
  search: "20px"
  primary: "24px"
  choice: "28px"
  square: "0"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "28": "28px"
  "32": "32px"
  "40": "40px"
  "48": "48px"
  "56": "56px"
components:
  button-plain:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.primary}"
    padding: "9px 22px"
  button-outline:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-link:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "2px 0"
  button-text:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 0"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  course-card:
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22px 22px 18px"
  material-tab:
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.square}"
    padding: "10px 0"
  filter-chip:
    textColor: "{colors.muted}"
    rounded: "{rounded.filter}"
    padding: "7px 14px"
  passage-tools:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.passage-tools}"
    padding: "3px 6px"
  feedback:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "16px"
  code-block:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.control}"
    padding: "16px 20px"
---

# Design System: Parallax wireframe

## Overview

This records the reusable visual decisions in [the unified wireframe](docs/wireframe.html). The source HTML and rendered states are the evidence for this system. It is a design artifact with fictional course material and local demonstrations; [the product specification](docs/product-spec.md) identifies the services and behaviours still required for an implemented application. [The reconciliation record](docs/design-reconciliation.md) records how Fable’s review and counterproposal informed the unified design.

The working surface gives course material the most space. White and neutral-grey grounds, charcoal controls, fine borders, and familiar sans-serif type follow the user's reference composition. Course cards lead to a compact syllabus table, then a full-width topic with material tabs and local controls. Yellow marks selected passages. Small geometric diagrams identify course subjects. No raster assets or downloaded fonts ship with the wireframe.

**Key Characteristics:**

- Continuous reading and notebook material with optional source-specific notes.
- Compact navigation, course-specific actions, and clear selected states.
- Light and dark palettes with distinct workspace and sheet roles.
- Flat surfaces separated by spacing, tone, and fine borders.

## Colors

The palette is neutral, with yellow for marked passages and restrained green for labelled success states. Frontmatter preserves the source's `light-dark()` pairs: light first, dark second.

### Primary

- **Ink** (`ink`) is the source for primary control fills as well as text and plot marks. The source alias `--pc-accent:var(--pc-ink)` remains live; components refer to `colors.ink` rather than a duplicate colour primitive.
- **Inverse control text** (`accent-ink`) labels filled controls and passage tools. Its dark value serves the pale control fill; it is not an alias of Workspace.
- **Success green** (`success`) accompanies saved or released status text. It is not a general decorative accent.

### Secondary

- **Passage yellow** (`highlight`) marks a passage or text selection while retaining normal ink. It does not colour the page ground.

### Neutral

- **Workspace** (`paper`) is the main background. **Sheet** (`sheet`) supports fields, toolbars, and slides. Their light values coincide; their dark values distinguish the canvas from these content surfaces. Keep both semantic roles.
- **Secondary surface** (`secondary`) identifies code blocks and review-table headings. The syllabus header stays unfilled.
- **Secondary ink** (`muted`) carries captions, metadata, and quieter controls. It also gives input boundaries more contrast than structural dividers.
- **Rule** (`rule`) separates regions and rows. **Soft surface** (`soft`) distinguishes selected filters, the current syllabus row, note fields, feedback, plot fill, and slide letterboxes.

**The Shared Ink Rule.** Primary control colour follows Ink in both themes; do not maintain a second charcoal palette.

## Typography

Segoe UI, with Arial and Helvetica fallbacks, serves headings, reading, and controls. This application typography is an explicit reference-led choice for the wireframe. Code uses the monospace stacks in the tokens. Georgia with a Times New Roman fallback is limited to the mathematical equation; it is not a heading or display family.

The shared title role covers page, topic, and reading titles. General section headings use the section role and smaller subheads use the subsection role. Reading paragraphs use the body role within a maximum measure of 720 px. Metadata and captions use the label role. General editable text uses the field role; textareas increase its line height to 1.6 and the code editor has its own monospace role.

Local variants belong to the content hierarchy: course-card titles use 18 px / 1.3 with -0.01 em tracking; reading subheads use 21 px; note headings use 17 px; the learning objective uses 15 px / 1.4. Navigation and filter labels use 12–14 px. The wordmark uses 19 px, weight 650, and -0.03 em tracking. Slide titles use 38 px with -0.03 em tracking, 32 px at the tablet breakpoint, and 28 px on phones; the more specific slide-notes rule retains a 30 px title. Slide supporting prose uses 22 px / 1.5, becoming 20 px at the tablet breakpoint; the more specific notes variant retains 18 px. Equations use 48 px serif type with 1 px tracking. On phones, topic titles become 24 px, reading titles 27 px, reading body 17 px, and rendered code 13 px. Editable code remains 16 px.

**The Content Type Rule.** Use the shared sans-serif hierarchy for interface and prose; reserve monospace for code and the serif exception for mathematical notation.

## Layout

The topic shell is full-width, capped at 1600 px, with no permanent rail. The global bar, topic heading, tabs, and resource toolbar have CSS minimum heights of 56, 100, 44, and 44 px. The topic heading's title, one-line objective, metadata, and padding produce approximately 120 px at the desktop reference size; this is an observed composition, not a fixed height. All regions can grow when content wraps.

The desktop stage has 40 px horizontal insets. A reading column up to 720 px sits beside a 280 px notes margin with a 56 px gap, centred within 1080 px. After rendering and on resize, the note block is offset by the measured distance to its source passage. The passage's Highlight / Note / Ask toolbar follows the paragraph in document flow, so it cannot cover wrapped text or the figure below. The figure carries Sketch. The notes tabs stay at the margin's top; the selected note aligns with its passage.

Course selection uses three columns with 20 px gaps within a 1200 px index. Topics use a compact, horizontally contained syllabus table. Notebook material has a maximum width of 1160 px. Assessment prompt and editor use an approximately 43/57 split with a 48 px gap and a quiet divider. Instructor review reserves 310 px for its rubric beside a flexible work area; authoring uses a 280 px side area.

The wireframe adapts in document flow:

- At 1199 px and below, stage side padding becomes 32 px, with a 260 px reading-notes column and a 32 px gap.
- At 800 px and below, stage side padding becomes 24 px, splits stack, notes follow the material, and course cards use two columns. Global navigation wraps rather than hiding neighbouring topics.
- At 540 px and below, stage side padding becomes 16 px, course cards use one column with 14 px gaps, and slides use a content-driven height with a 410 px minimum. Tabs wrap; tables scroll inside their own containers.
- Coarse-pointer controls use a minimum 44 × 44 px target. The card's full-width opening button retains its content-sized area; inline text anchors keep their text-selection form and have a separate Note action.

Slides use a 16:9 sheet with neutral letterboxes and a maximum width of 1240 px. Optional slide annotations allocate a 280 px margin with a 32 px gap and refit the slide. A standalone wide, tall viewport rule sizes the sheet from available height; small screens can grow vertically. Focus hides the global bar, topic heading, material tabs, and demo chrome while retaining resource tools and reading measure. Browser Full screen requests a separate display mode, uses the Focus layout, and falls back to Focus when unavailable. Both exits restore the workspace. Optional inline-host state remembers only view, material tab, and preview role; work remains in memory and resets on reload.

## Elevation & Depth

There are no shadows, gradients, or blur layers. Surface tone, one-pixel dividers, and spacing distinguish material, notes, and controls. Course-card border colour transitions over 150 ms with ease; other state changes are immediate. Reduced motion removes transitions and smooth scrolling. Native keyboard focus remains visible; the slide stage adds a two-pixel inset outline when keyboard-focused.

**The Flat Surface Rule.** Distinguish regions through tone, fine borders, and space, without introducing decorative shadow layers.

## Shapes

Ordinary controls, fields, feedback, and code blocks use the control radius. The card, note, primary-action, and exercise-choice radii each have distinct roles. Catalog filters and search use their own rounded forms; the compact passage toolbar uses the passage-tools radius. Tabs, slides, and the code editor remain square. Resource-presence marks have a local 1 px radius, while sample points are circles. These diagram marks are content geometry, not new control shapes. Continuous reading and notebook material stay unboxed.

## Components

**Buttons.** Primary actions have a solid Ink fill, inverse text, semibold labels, the primary radius, and 9 × 22 px padding. This is the deliberate rule in the single component stylesheet. Outline actions use Sheet with a Secondary ink border. Plain and text buttons have no resting fill; link buttons add an underline. Default hover uses Soft, primary hover applies `brightness(.9)`, and outline hover retains Sheet. Disabled buttons use .55 opacity. Browser-native focus remains intact.

**Fields.** General inputs, textareas, and selects use Sheet with a one-pixel Secondary ink border. Catalog search has a Rule border and the search radius; its text resolves to the general editable-field size. Textareas resize vertically. Notes use Soft, the note radius, 12 px padding, a Rule border that darkens on focus, and a 140 px minimum height. The square code editor has 20 px padding and a 260 px minimum height. No separate error-field colour treatment is defined; errors use explicit text.

**Navigation.** Courses and Topics sit in the global bar with previous/next topic controls on the right. The preview-role selector belongs in the demonstration footer. The current syllabus row uses Soft, a semibold title, and one underlined Resume action. Filled or empty resource squares have accessible labels and a letter legend. Material tabs retain the Slides / Reading / Exercises / Notebooks / Tests order. Muted labels turn to Ink on hover; the selected tab adds semibold weight and a two-pixel underline. Notes and Discussion use the same underline convention at a smaller scale.

**Course catalog.** Each bordered card is an article with a distinct course-opening button and its own contextual action. Student cards show reviewed counts, Resume where available, and a two-pixel progress line; instructor cards expose Class review where provided. Cards contain one small geometric subject diagram, a title, and metadata. Hover strengthens only the border. All, In progress, and Archived use rounded filter buttons with a Soft selected fill. Title search sits alongside the filters. Progress means reviewed topics, not grades.

**Annotations.** Highlight / Note / Ask shares one compact inverse toolbar adjacent to the marked passage. Sketch opens from the figure. The notes margin pairs a bordered source excerpt with a labelled textarea; My notes remains private, while Ask uses an explicit Instructor or Class audience. Slide annotations are keyed to the displayed slide and use the same margin pattern. The local Saving → Saved demonstration preserves pending state across navigation but is not a server acknowledgement.

**Learning and review.** Exercises show three labelled steps—Predict, Inspect, Explain—with a thin segmented progress track. Rounded answer choices and soft feedback keep focus on the task. Notebook cells pair a narrow execution-number column with bordered code and unboxed output. The slide stage has a position line above Previous / count / Next, an optional jump index, and optional annotations. Instructor traversal sits beside the recipient, follows the current filter, and preserves each student's draft. Topic draft preview is visibly isolated from the class's adopted release.

The schemaVersion 2 sidecar supplies isolated previews of the five button variants, field, course card, material tabs, filter, and passage toolbar. Its colour ramps are panel previews, not additional colours adopted by the wireframe. Alias metadata records the CSS relationship without duplicating a primitive.

## Do's and Don'ts

### Do:

- **Do** keep reading, code, and slides spacious while navigation remains compact.
- **Do** use the light and dark members of each colour token together and preserve Workspace and Sheet as separate roles.
- **Do** retain text labels, selected-state cues, audience labels, and visible keyboard focus.
- **Do** let regions grow or stack when text or viewport size requires it.
- **Do** keep passage actions beside their source in document flow and position notes from measured anchors.

### Don't:

- **Don't** restore tan or cream grounds, rust accents, or display-serif headings.
- **Don't** fragment continuous reading or notebook material into decorative cards or dashboard tiles.
- **Don't** duplicate the Ink palette or revive obsolete rail tokens and override layers.
- **Don't** present prototype states or proposed product behaviours as implemented services.
