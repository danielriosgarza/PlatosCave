import { testV1 } from '@parallax/contracts';
import { and, eq } from 'drizzle-orm';
import { hasManualPart } from '../assessments/grading';
import type { ClassContext, ClassManagerScope } from '../auth/scope';
import { audit } from './audit';
import type { Db, Executor } from './client';
import { classes, releaseResources, resourceRevisions } from './schema';

/**
 * The open class setting (§13, N10), off unless set. An open class takes no post to the class or
 * to instructors (`annotations/annotations.ts`), and nobody grades in it, so it never holds a
 * release with manually graded test parts: opening a class refuses one here, and adopting one into
 * an open class is refused at adoption.
 */

export type SetOpenResult =
  | { ok: true; open: boolean }
  | { ok: false; reason: 'class_archived' | 'manual_grading' };

/**
 * Whether a release of the scope's course holds a test with a question an instructor marks by
 * hand, whatever the test's visibility. A test whose definition does not parse counts too:
 * nothing can score it.
 */
export async function releaseNeedsGrader(
  ex: Executor,
  scope: ClassContext,
  releaseId: string,
): Promise<boolean> {
  const rows = await ex
    .select({ content: resourceRevisions.content })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(
      and(
        eq(releaseResources.releaseId, releaseId),
        eq(resourceRevisions.courseId, scope.courseId),
        eq(resourceRevisions.type, 'test'),
      ),
    );
  return rows.some(({ content }) => {
    const test = testV1.safeParse(content);
    return !test.success || test.data.questions.some(hasManualPart);
  });
}

/**
 * Opens the scope's class or closes it again. The class row is locked as adoption locks it, so a
 * release cannot be adopted between the check of the class's release and the change. An archived
 * class refuses, as every write to it does (§4). Setting the value the class already has changes
 * nothing and records nothing; a change is audited as `class.open`.
 */
export function setClassOpen(
  db: Db,
  scope: ClassManagerScope,
  open: boolean,
): Promise<SetOpenResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ open: classes.open, releaseId: classes.releaseId, archivedAt: classes.archivedAt })
      .from(classes)
      .where(eq(classes.id, scope.classId))
      .for('update');
    if (!row) throw new Error(`class ${scope.classId} of a resolved scope does not exist`);
    if (scope.archived || row.archivedAt) return { ok: false, reason: 'class_archived' };
    if (row.open === open) return { ok: true, open };
    if (open && row.releaseId && (await releaseNeedsGrader(tx, scope, row.releaseId))) {
      return { ok: false, reason: 'manual_grading' };
    }
    await tx.update(classes).set({ open }).where(eq(classes.id, scope.classId));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.open',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      before: { open: row.open },
      after: { open, via: scope.via },
    });
    return { ok: true, open };
  });
}
