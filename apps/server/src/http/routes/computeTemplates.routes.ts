import {
  archiveComputeTemplate,
  type ComputeTemplateView,
  createComputeTemplate,
  listComputeTemplates,
  updateComputeTemplate,
} from '@parallax/contracts/routes/computeTemplates';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as templates from '../../db/connectors/templates';
import { notFound, registerRoute } from '../register';

/** A template as the routes answer it: what it holds, without who confirmed or made it. */
const templateView = (row: templates.Template): ComputeTemplateView => ({
  id: row.id,
  classId: row.classId,
  name: row.name,
  description: row.description,
  target: row.target,
  runtime: row.runtime,
  isolation: row.isolation,
  lease: row.lease,
  hostOwnerConfirmedAt: row.hostOwnerConfirmedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

/**
 * Class host templates (docs/design/connector.md §11): every member reads them; instructors
 * publish, change and archive them after a recent sign-in, stating that the host owner permits
 * this use (the contract requires `hostOwnerConfirmed: true`).
 */
export default function computeTemplateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { now } = deps;
  const db = deps.requireDb;

  registerRoute(app, listComputeTemplates, async ({ scope }) => {
    const rows = await templates.listTemplates(db(), scope);
    return rows.map(templateView);
  });

  registerRoute(app, createComputeTemplate, async ({ scope, body, fail }) => {
    scope.requireRecentAuth();
    const result = await templates.createTemplate(db(), scope, body, now());
    if (result.ok) return templateView(result.template);
    if (result.reason === 'target_not_allowed') {
      return fail(400, {
        error: 'target_not_allowed',
        code: result.code,
        ...(result.rules && { rules: result.rules }),
      });
    }
    if (result.reason === 'class_archived') return fail(409, { error: 'class_archived' });
    return notFound();
  });

  registerRoute(app, updateComputeTemplate, async ({ scope, params, body, fail }) => {
    scope.requireRecentAuth();
    const result = await templates.updateTemplate(db(), scope, params.templateId, body, now());
    if (result.ok) return templateView(result.template);
    if (result.reason === 'class_archived') return fail(409, { error: 'class_archived' });
    // A stored template always passes its own check: only `not_found` remains.
    return notFound();
  });

  registerRoute(app, archiveComputeTemplate, async ({ scope, params, fail }) => {
    scope.requireRecentAuth();
    const result = await templates.archiveTemplate(db(), scope, params.templateId, now());
    if (result.ok) return templateView(result.template);
    if (result.reason === 'class_archived') return fail(409, { error: 'class_archived' });
    return notFound();
  });
}
