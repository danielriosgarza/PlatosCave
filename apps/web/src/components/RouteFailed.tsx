import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { SessionCheckError } from '../session/useSession';
import page from './Page.module.css';
import { RetryNotice } from './RetryNotice';

/**
 * The global bar stays (it belongs to the root); the page says what failed and offers Retry (§14).
 * Child routes have no boundary of their own, so any error under `/_authed` lands here too.
 */
export function RouteFailed({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const session = error instanceof SessionCheckError;
  return (
    <main id="main" className={page.index}>
      <RetryNotice
        message={
          session
            ? 'Your session could not be checked, so this page is not shown.'
            : 'This page could not be shown.'
        }
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </main>
  );
}
