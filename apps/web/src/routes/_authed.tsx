import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { PreviewBanner } from '../preview/PreviewBanner';
import { loadSession, useSession } from '../session/useSession';

/** Everything below needs a session; the intended address travels in `next` (§3). */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await loadSession(context.queryClient);
    if (!me) throw redirect({ to: '/signin', search: { next: location.href } });
  },
  component: Authed,
  errorComponent: SessionCheckFailed,
});

/** The global bar stays (it belongs to the root); the page says what failed and offers Retry (§14). */
function SessionCheckFailed() {
  const router = useRouter();
  return (
    <main className={page.index}>
      <RetryNotice
        message="Your session could not be checked, so this page is not shown. Nothing was changed."
        onRetry={() => void router.invalidate()}
      />
    </main>
  );
}

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
