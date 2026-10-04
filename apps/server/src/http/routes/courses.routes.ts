import { createCourse, listCourses } from '@parallax/contracts/routes/courses';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { createCourseFor, listCourseCards } from '../../db/catalog';
import { registerRoute } from '../register';

export default function courseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;

  registerRoute(app, listCourses, ({ scope }) => listCourseCards(db(), scope, deps.now()));

  registerRoute(app, createCourse, async ({ scope, body, fail }) => {
    const created = await createCourseFor(db(), scope, body.title);
    if (created === 'not_instructor') return fail(403, { error: 'not_instructor' });
    return created;
  });
}
