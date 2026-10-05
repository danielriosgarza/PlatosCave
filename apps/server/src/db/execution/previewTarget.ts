import { testV1 } from '@parallax/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { CourseScope } from '../../auth/scope';
import { invalid, notFound, type Outcome } from '../../outcome';
import type { Db } from '../client';
import { resourceRevisions, resources } from '../schema';
import { forCourse } from '../scoped';

/**
 * The head revision of a draft test and the code question of it a preview run is asked for.
 * Read through the editor's course scope: a class scope never reads draft rows (ADR-0003).
 * Content that is not `test.v1` (or has no such code question) is refused, so an unfinished
 * draft is reported instead of run.
 */
export async function previewTarget(
  db: Db,
  scope: CourseScope,
  resourceId: string,
  questionId: string,
): Promise<Outcome<{ revisionId: string }>> {
  const [row] = await db
    .select({ revisionId: resourceRevisions.id, content: resourceRevisions.content })
    .from(resources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, resources.headRevisionId))
    .where(
      and(
        forCourse(scope, resources),
        forCourse(scope, resourceRevisions),
        eq(resources.id, resourceId),
        eq(resources.type, 'test'),
        isNull(resources.archivedAt),
      ),
    );
  if (!row) return notFound;
  const parsed = testV1.safeParse(row.content);
  if (!parsed.success) return invalid('The test is not valid yet; fix it and try again');
  const question = parsed.data.questions.find((q) => q.id === questionId);
  if (question?.kind !== 'code') return notFound;
  return { ok: true, value: { revisionId: row.revisionId } };
}
