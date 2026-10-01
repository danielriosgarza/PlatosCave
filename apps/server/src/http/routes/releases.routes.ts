import {
  adoptRelease,
  getClassRelease,
  listClassReleases,
  previewAdoption,
  publishRelease,
  validateDrafts,
} from '@parallax/contracts/routes/releases';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Deps } from '../../app';
import * as adoption from '../../db/content/adoption';
import * as releases from '../../db/content/releases';
import { enqueueAnnotationsMap } from '../../jobs/annotations-map.job';
import { notFound, registerRoute } from '../register';

const iso = (d: Date) => d.toISOString();

/** Error replies carry a body the contract's 200 schema does not describe. */
const fail = (reply: FastifyReply, status: number, body: Record<string, unknown>) =>
  reply.code(status).send(body) as never;

export default function releaseRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };

  registerRoute(app, validateDrafts, ({ scope }) => releases.validateDrafts(db(), scope));

  registerRoute(app, publishRelease, async ({ scope, reply }) => {
    const result = await releases.publishRelease(db(), scope);
    if (!result.ok) return fail(reply, 422, { error: 'validation_failed', report: result.report });
    const { id, version, createdAt } = result.release;
    return { release: { id, version, createdAt: iso(createdAt) }, report: result.report };
  });

  registerRoute(app, getClassRelease, async ({ scope }) => {
    const { release, topics } = await releases.readClassRelease(db(), scope);
    return {
      release: release && {
        id: release.id,
        version: release.version,
        createdAt: iso(release.createdAt),
      },
      topics: topics.map((t) => ({
        id: t.id,
        topicId: t.topicId,
        position: t.position,
        title: t.title,
        objective: t.objective,
        prerequisites: t.prerequisites,
        estimatedMinutes: t.estimatedMinutes,
        resources: t.resources.map((r) => ({
          id: r.id,
          resourceId: r.resourceId,
          revisionId: r.revisionId,
          type: r.type,
          tab: r.tab,
          position: r.position,
          title: r.title,
          visibility: r.visibility,
          releaseAt: r.releaseAt && iso(r.releaseAt),
        })),
      })),
    };
  });

  registerRoute(app, listClassReleases, async ({ scope }) => {
    const list = await adoption.listClassReleases(db(), scope);
    return {
      currentReleaseId: list.currentReleaseId,
      releases: list.releases.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
      history: list.history.map((h) => ({ ...h, createdAt: iso(h.createdAt) })),
    };
  });

  registerRoute(app, previewAdoption, async ({ scope, query }) => {
    const diff = await adoption.previewAdoption(db(), scope, query.releaseId);
    return diff ?? notFound();
  });

  registerRoute(app, adoptRelease, async ({ scope, body, reply, req }) => {
    const result = await adoption.adoptRelease(db(), scope, body);
    if (result.ok) {
      // Marks are mapped onto the new revisions in the background (ADR-0003). The adoption has
      // committed either way; until the job runs, reads show those marks as pending.
      if (deps.boss && result.diff.from?.id !== result.releaseId) {
        await enqueueAnnotationsMap(deps.boss, scope, result.releaseId).catch((err) =>
          req.log.error({ err, classId: scope.classId }, 'could not queue annotation mapping'),
        );
      }
      return { releaseId: result.releaseId, diff: result.diff };
    }
    if (result.reason === 'not_found') notFound();
    if (result.reason === 'class_archived') return fail(reply, 409, { error: 'class_archived' });
    return fail(reply, 409, {
      error: 'release_conflict',
      currentReleaseId: result.currentReleaseId,
    });
  });
}
