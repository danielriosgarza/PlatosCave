import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { loadSession } from '../session/useSession';

/** Everything below needs a session; the intended address travels in `next` (§3). */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await loadSession(context.queryClient);
    if (!me) throw redirect({ to: '/signin', search: { next: location.href } });
  },
  component: Outlet,
});
