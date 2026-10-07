/** Kinds of study material a resource can be (§5); the database enum `resource_type` matches. */
export const resourceTypes = [
  'slides_pdf',
  'slides_web',
  'reading_native',
  'reading_pdf',
  'exercise',
  'notebook',
  'shiny',
  'test',
] as const;
export type ResourceType = (typeof resourceTypes)[number];

/** The five study tabs of a topic (§4), in display order. */
export const tabs = ['slides', 'reading', 'exercises', 'notebooks', 'tests'] as const;
export type Tab = (typeof tabs)[number];
