---
version: 1
slug: "docs-wireframe-html"
primary_target: "docs/wireframe.html"
related_targets: []
---

# Course workspace redesign

Scope: `docs/wireframe.html` and its inline preview. Mode: Operate, with a Read surface inside the Reading tab. Existing content, navigation, fixture interactions, and the documentation-only deliverable remain in scope.

## Direction contract

**THESIS.** Follow the supplied `docs/idea_draft.png`: choose a course card, scan its topic table, then work in a full-width topic. Material tabs and a local toolbar sit above the lesson; notes sit beside their passage.

**OWN-WORLD.** White content, charcoal controls, thin rules and progress lines, one sans-serif family. Course cards have modest corners; primary actions and exercise choices are rounded. Yellow is reserved for highlighted passages. Small geometric subject diagrams echo the reference's sparse scientific marks. No tan ground or display-serif pairing.

**STORY.** A learner finds a topic, switches between explanations and practice, and keeps notes beside the material. An instructor moves from the same topic into student review.

**FIRST VIEWPORT.** The catalog opens as a three-column course grid at desktop width. The topic workspace has a 56 px global bar, approximately 120 px heading with a learning objective, 44 px tab row, 44 px local toolbar, and 40 px horizontal inset. No permanent topic rail. Reading uses a maximum 720 px measure with a 280 px notes margin and 56 px gap. Slides fill the stage with grey letterboxes. Full screen and F expand the material; exiting browser full screen restores the normal workspace.

**FORM.** The user-supplied image now governs composition; the prior seeded proposal is superseded on layout. This is an adaptation of an established neutral visual system to a specific reference, not a new direction tournament. The image is inspiration rather than a pixel reproduction target. Existing statistical examples and instructor interactions remain. Reference runtime labels are not copied as integration claims. Code-native wireframe editing continues; no standing build preference changes.

**FINISH.** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Design constraints

Do not implement the application. Preserve all five tabs and existing fixture interactions. Responsive layout, keyboard access, light/dark appearance, and full-screen/focus behaviour remain inspectable. No shipping raster assets are needed.

## Unified review decisions

Fable’s counterproposal supplies the flattened component stylesheet and revised navigation. `docs/design-reconciliation.md` resolves every review comment. Keep student and teaching entrances, Focus and Full screen, semantic Workspace/Sheet roles, and truthful preview status. Use passage-measured notes, adjacent Highlight/Note/Ask tools, figure sketches, optional slide annotations, three exercise steps, filtered student traversal, and isolated draft preview. Demo controls belong in the footer. Keep review comments and decisions in Markdown; docs/wireframe.html is the sole HTML deliverable. Keep the canonical spec and visual system aligned.
