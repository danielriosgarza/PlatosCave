import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { RouteFailed } from '../components/RouteFailed';
import { PreviewBanner } from '../preview/PreviewBanner';
import { loadSessionOrCached, useSession } from '../session/useSession';

/** Everything below needs a session; the intended address travels in `next` (§3). */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await loadSessionOrCached(context.queryClient);
    if (!me) throw redirect({ to: '/signin', search: { next: location.href } });
  },
  component: Authed,
  errorComponent: RouteFailed,
});

/** A session that ends while a page is open (expiry, sign-out in another tab) leaves too. */
function Authed() {
  const session = useSession();
  const navigate = useNavigate();
  const href = useLocation({ select: (l) => l.href });
  // The layout can still be mounted for a moment after the move to /signin; never chain from it.
  const onSignin = useLocation({ select: (l) => l.pathname === '/signin' });
  const signedOut = session.status === 'signed-out' && !onSignin;
  useEffect(() => {
    if (signedOut) void navigate({ to: '/signin', search: { next: href }, replace: true });
  }, [signedOut, href, navigate]);
  return (
    <>
      <PreviewBanner />
      <Outlet />
    </>
  );
}
