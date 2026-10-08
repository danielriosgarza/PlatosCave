import { validateTarget } from '@parallax/contracts';
import {
  type ComputeTemplateView,
  type TemplateTarget,
  targetFromTemplate,
  USER_PLACEHOLDER,
} from '@parallax/contracts/routes/computeTemplates';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ClassScope, UserScope } from '../../auth/scope';
import { audit } from '../audit';
import type { Db, Tx } from '../client';
import { classComputeTemplates, classMemberships } from '../schema';
import { forClass } from '../scoped';

/**
 * Class host templates (docs/design/connector.md §11; spec §10.3): a host, runtime and isolation
 * an instructor publishes for one class, with the statement that the host owner permits this
 * use. A template holds no user and no credential; learners make their own connections from it
 * (db/connectors/connections.ts). Every function here reads and writes through the class scope.
 */

export type TemplateRow = typeof classComputeTemplates.$inferSelect;
type Lease = { idleTimeoutMin: number; gracePeriodMin: number };

export type Template = Omit<TemplateRow, 'target' | 'runtime' | 'lease'> & {
  target: TemplateTarget;
  runtime: ComputeTemplateView['runtime'];
  lease: Lease | null;
};

const typed = (row: TemplateRow) => row as Template;

export type TemplateRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'class_archived' }
  | {
      ok: false;
      reason: 'target_not_allowed';
      code: 'invalid_target' | 'workspace_needs_user';
      rules?: number[];
    };

/** The template event of design §10.2, in the template's class scope. */
const templateEvent = (
  actorId: string,
  classId: string,
  action: 'template.published' | 'template.archived' | 'template.used',
  templateId: string,
  before: object | null,
  after: object | null,
  createdAt: Date,
) => ({
  actorId,
  action,
  scopeKind: 'class' as const,
  scopeId: classId,
  targetType: 'compute_template',
  targetId: templateId,
  before,
  after,
  createdAt,
});

/** What the audit trail keeps of a template: everything it holds, none of it a secret. */
const summary = (t: Pick<Template, 'name' | 'target' | 'isolation' | 'lease'>) => ({
  name: t.name,
  target: t.target,
  isolation: t.isolation,
  lease: t.lease,
});

/** A stand-in account for checking a template against the rules every connection must pass. */
const SAMPLE_ACCOUNT = { user: 'learner', auth: { method: 'agent' as const, hint: 'learner' } };

/**
 * Rules 1–8 of design §4.4 for the connections a template will make, checked with a sample
 * account. On a host isolated by OS account the workspace must name the learner's own account,
 * or every learner would be pointed at one directory.
 */
export function checkTemplate(
  target: TemplateTarget,
  runtime: Template['runtime'],
  isolation: Template['isolation'],
): TemplateRefusal | null {
  const issues = validateTarget({ target: targetFromTemplate(target, SAMPLE_ACCOUNT), runtime });
  if (issues.length > 0) {
    const rules = [...new Set(issues.map((i) => i.rule))].sort();
    return { ok: false, reason: 'target_not_allowed', code: 'invalid_target', rules };
  }
  if (isolation === 'account' && !target.workspace.includes(USER_PLACEHOLDER)) {
    return { ok: false, reason: 'target_not_allowed', code: 'workspace_needs_user' };
  }
  return null;
}

/** The class's unarchived templates, oldest first. */
export async function listTemplates(db: Db, scope: ClassScope): Promise<Template[]> {
  const rows = await db
    .select()
    .from(classComputeTemplates)
    .where(and(forClass(scope, classComputeTemplates), isNull(classComputeTemplates.archivedAt)))
    .orderBy(asc(classComputeTemplates.createdAt), asc(classComputeTemplates.id));
  return rows.map(typed);
}

async function findTemplate(tx: Tx, scope: ClassScope, templateId: string) {
  const [row] = await tx
    .select()
    .from(classComputeTemplates)
    .where(
      and(
        forClass(scope, classComputeTemplates),
        eq(classComputeTemplates.id, templateId),
        isNull(classComputeTemplates.archivedAt),
      ),
    )
    .for('update');
  return row ? typed(row) : null;
}

export interface NewTemplate {
  name: string;
  description: string;
  target: TemplateTarget;
  runtime: Template['runtime'];
  isolation: Template['isolation'];
  lease?: Lease | null | undefined;
}

/**
 * Publishes a template (the route has checked the instructor role, the recent sign-in and the
 * host-owner statement, which this records as the caller's, now).
 */
export async function createTemplate(
  db: Db,
  scope: ClassScope,
  input: NewTemplate,
  now: Date,
): Promise<{ ok: true; template: Template } | TemplateRefusal> {
  if (scope.archived) return { ok: false, reason: 'class_archived' };
  const refused = checkTemplate(input.target, input.runtime, input.isolation);
  if (refused) return refused;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(classComputeTemplates)
      .values({
        classId: scope.classId,
        name: input.name,
        description: input.description,
        target: input.target,
        runtime: input.runtime,
        isolation: input.isolation,
        lease: input.lease ?? null,
        hostOwnerConfirmedBy: scope.user.id,
        hostOwnerConfirmedAt: now,
        createdBy: scope.user.id,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('template insert returned no row');
    const template = typed(row);
    await audit(
      tx,
      templateEvent(
        scope.user.id,
        scope.classId,
        'template.published',
        row.id,
        null,
        summary(template),
        now,
      ),
    );
    return { ok: true as const, template };
  });
}

export interface TemplateChange {
  name?: string | undefined;
  description?: string | undefined;
  isolation?: Template['isolation'] | undefined;
  lease?: Lease | null | undefined;
}

/**
 * Changes what a template says about itself; the host-owner statement is recorded again. Its
 * target and runtime are fixed (connections hold them).
 */
export async function updateTemplate(
  db: Db,
  scope: ClassScope,
  templateId: string,
  change: TemplateChange,
  now: Date,
): Promise<{ ok: true; template: Template } | TemplateRefusal> {
  if (scope.archived) return { ok: false, reason: 'class_archived' };
  return db.transaction(async (tx) => {
    const current = await findTemplate(tx, scope, templateId);
    if (!current) return { ok: false as const, reason: 'not_found' as const };
    const isolation = change.isolation ?? current.isolation;
    const refused = checkTemplate(current.target, current.runtime, isolation);
    if (refused) return refused;
    const [row] = await tx
      .update(classComputeTemplates)
      .set({
        ...(change.name !== undefined && { name: change.name }),
        ...(change.description !== undefined && { description: change.description }),
        ...(change.lease !== undefined && { lease: change.lease }),
        isolation,
        hostOwnerConfirmedBy: scope.user.id,
        hostOwnerConfirmedAt: now,
      })
      .where(eq(classComputeTemplates.id, current.id))
      .returning();
    if (!row) throw new Error('template vanished inside its transaction');
    const template = typed(row);
    await audit(
      tx,
      templateEvent(
        scope.user.id,
        scope.classId,
        'template.published',
        row.id,
        summary(current),
        summary(template),
        now,
      ),
    );
    return { ok: true as const, template };
  });
}

/** Archives a template: no new connection is made from it and its connections stop opening. */
export async function archiveTemplate(
  db: Db,
  scope: ClassScope,
  templateId: string,
  now: Date,
): Promise<{ ok: true; template: Template } | TemplateRefusal> {
  if (scope.archived) return { ok: false, reason: 'class_archived' };
  return db.transaction(async (tx) => {
    const current = await findTemplate(tx, scope, templateId);
    if (!current) return { ok: false as const, reason: 'not_found' as const };
    const [row] = await tx
      .update(classComputeTemplates)
      .set({ archivedAt: now })
      .where(eq(classComputeTemplates.id, current.id))
      .returning();
    if (!row) throw new Error('template vanished inside its transaction');
    await audit(
      tx,
      templateEvent(
        scope.user.id,
        scope.classId,
        'template.archived',
        row.id,
        { name: current.name },
        null,
        now,
      ),
    );
    return { ok: true as const, template: typed(row) };
  });
}

/**
 * An unarchived template of a class the caller belongs to as a real member (not a preview), for
 * making a connection from it; null otherwise, whoever made it.
 */
export async function usableTemplate(
  tx: Tx,
  scope: UserScope,
  templateId: string,
): Promise<{ id: string; classId: string; target: unknown; runtime: unknown } | null> {
  const [row] = await tx
    .select({
      id: classComputeTemplates.id,
      classId: classComputeTemplates.classId,
      target: classComputeTemplates.target,
      runtime: classComputeTemplates.runtime,
    })
    .from(classComputeTemplates)
    .innerJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, classComputeTemplates.classId),
        eq(classMemberships.userId, scope.user.id),
        eq(classMemberships.isPreview, false),
      ),
    )
    .where(and(eq(classComputeTemplates.id, templateId), isNull(classComputeTemplates.archivedAt)));
  return row ?? null;
}

/** The target and runtime a connection's template holds, for checking a change to it. */
export async function templateHeldBy(
  tx: Tx,
  templateId: string,
): Promise<{ target: unknown; runtime: unknown }> {
  const [row] = await tx
    .select({ target: classComputeTemplates.target, runtime: classComputeTemplates.runtime })
    .from(classComputeTemplates)
    .where(eq(classComputeTemplates.id, templateId));
  return { target: row?.target, runtime: row?.runtime };
}

/** `template.used`: a learner made a connection from a class's template, in that class. */
export const templateUsed = (
  tx: Tx,
  scope: UserScope,
  template: { id: string; classId: string },
  connectionId: string,
  now: Date,
) =>
  audit(
    tx,
    templateEvent(
      scope.user.id,
      template.classId,
      'template.used',
      template.id,
      null,
      { connectionId },
      now,
    ),
  );
