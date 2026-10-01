import { getClassTopics } from '@parallax/contracts/routes/topics';
import type { FastifyInstance } from 'fastify';
import { loadClassTopics } from '../../db/classTopics';
import { registerRoute } from '../register';

export default function topicRoutes(app: FastifyInstance): void {
  registerRoute(app, getClassTopics, async ({ scope }) => {
    const { db, now } = app.resolverDeps;
    if (!db) throw app.httpErrors.serviceUnavailable();
    const view = await loadClassTopics(db, scope, now());
    return {
      release: view.release,
      course: { id: scope.courseId, title: scope.courseTitle },
      cohort: view.cohort,
      instructors: view.instructors,
      topics: view.topics.map((t) => ({
        topicId: t.topicId,
        number: t.number,
        title: t.title,
        objective: t.objective,
        estimatedMinutes: t.estimatedMinutes,
        presence: t.presence,
        firstTab: t.firstTab,
        savedTab: t.savedTab,
        state: t.availability.state,
        availableAt: t.availability.availableAt?.toISOString() ?? null,
        requires: t.availability.requires,
      })),
      resume: view.resume,
      reviewed: { count: view.reviewedCount, total: view.topics.length },
    };
  });
}
