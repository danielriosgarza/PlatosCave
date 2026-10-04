/**
 * Example ids for route contracts. The isolation matrix substitutes the fixture world's ids for
 * `classId` and `courseId`; every other example id only has to be a valid, unknown uuid.
 */
const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;

export const exampleIds = {
  zero: id('0'),
  aa: id('aa'),
  bb: id('bb'),
  cc: id('cc'),
  dd: id('dd'),
  ee: id('ee'),
} as const;
