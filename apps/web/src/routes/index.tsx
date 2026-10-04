import { createFileRoute, redirect } from '@tanstack/react-router';
import { loadSessionOrCached } from '../session/useSession';

/**
 * `/` has no page of its own. A signed-in person goes to their courses; a signed-out visitor goes
 * to /signin without `next`, so the entrance they choose there decides where they land (§3).
 */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const me = await loadSessionOrCached(context.queryClient);
    throw redirect({ to: me ? '/courses' : '/signin', replace: true });
  },
});
