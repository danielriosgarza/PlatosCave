import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/` has no page of its own: everyone goes to their courses, and the `/_authed` guard sends a
 * signed-out visitor on to /signin with the courses address kept in `next` (§3).
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/courses', replace: true });
  },
});
