import { createCourse, listCourses } from '@parallax/contracts/routes/courses';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { createCourseFor, listCourseCards } from '../../db/catalog';
import { refuse, registerRoute } from '../register';

export default function courseRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };

  registerRoute(app, listCourses, ({ scope }) => listCourseCards(db(), scope));

  registerRoute(app, createCourse, async ({ scope, body }) => {
    const created = await createCourseFor(db(), scope, body.title);
    if (created === 'not_instructor') return refuse(403, 'not_instructor');
    return created;
  });
}
