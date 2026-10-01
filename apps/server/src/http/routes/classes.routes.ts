import { getClass } from '@parallax/contracts/routes/classes';
import type { FastifyInstance } from 'fastify';
import { registerRoute } from '../register';

export default function classRoutes(app: FastifyInstance): void {
  registerRoute(app, getClass, ({ scope }) => ({
    id: scope.classId,
    name: scope.className,
    courseId: scope.courseId,
    courseTitle: scope.courseTitle,
    releaseId: scope.releaseId,
    archived: scope.archived,
    role: scope.role,
    grants: scope.grants,
  }));
}
