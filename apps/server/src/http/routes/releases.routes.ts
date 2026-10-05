import {
  adoptRelease,
  getClassRelease,
  listClassReleases,
  previewAdoption,
  publishRelease,
  validateDrafts,
} from '@parallax/contracts/routes/releases';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as adoption from '../../db/content/adoption';
import * as releases from '../../db/content/releases';
import { enqueueAnnotationsMap } from '../../jobs/annotations-map.job';
import { notFound, registerRoute } from '../register';

const iso = (d: Date) => d.toISOString();

export default function releaseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;

  registerRoute(app, validateDrafts, ({ scope }) =>
    releases.validateDrafts(db(), scope, deps.config.RUNNER_RUNTIMES),
  );

  registerRoute(app, publishRelease, async ({ scope, fail }) => {
    const result = await releases.publishRelease(db(), scope, {
      runtimes: deps.config.RUNNER_RUNTIMES,
    });
    if (!result.ok) return fail(422, { error: 'validation_failed', report: result.report });
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
          credit: r.credit,
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

  registerRoute(app, adoptRelease, async ({ scope, body, fail, req }) => {
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
    if (result.reason === 'class_archived') return fail(409, { error: 'class_archived' });
    return fail(409, {
      error: 'release_conflict',
      currentReleaseId: result.currentReleaseId,
    });
  });
}
