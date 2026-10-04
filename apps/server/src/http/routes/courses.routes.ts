import { createCourse, listCourses } from '@parallax/contracts/routes/courses';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { createCourseFor, listCourseCards, mayCreateCourse } from '../../db/catalog';
import { registerRoute } from '../register';

export default function courseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;

  const instructorEmails = deps.config.INSTRUCTOR_EMAILS;

  registerRoute(app, listCourses, async ({ scope }) => ({
    ...(await listCourseCards(db(), scope, deps.now())),
    canCreateCourse: await mayCreateCourse(db(), scope, instructorEmails),
  }));

  registerRoute(app, createCourse, async ({ scope, body, fail }) => {
    const created = await createCourseFor(db(), scope, body.title, instructorEmails);
    if (created === 'not_instructor') return fail(403, { error: 'not_instructor' });
    return created;
  });
}
