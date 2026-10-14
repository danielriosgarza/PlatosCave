import { getClass, setClassOpen } from '@parallax/contracts/routes/classes';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { setClassOpen as setOpen } from '../../db/openClass';
import { registerRoute } from '../register';

export default function classRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerRoute(app, getClass, ({ scope }) => ({
    id: scope.classId,
    name: scope.className,
    courseId: scope.courseId,
    courseTitle: scope.courseTitle,
    releaseId: scope.releaseId,
    archived: scope.archived,
    open: scope.open,
    role: scope.role,
    grants: scope.grants,
  }));

  registerRoute(app, setClassOpen, async ({ scope, body, fail }) => {
    const result = await setOpen(deps.requireDb(), scope, body.open);
    if (!result.ok) return fail(409, { error: result.reason });
    return { id: scope.classId, open: result.open };
  });
}
