import { createFileRoute, useNavigate } from '@tanstack/react-router';
import page from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { JoinForm } from '../../courses/Dialogs';

/**
 * A class's join link, `/join/<enrolment code>` (§13, N10: how a visitor joins an open class; it
 * works for any enrolment code). Sign-in comes first and returns here. Joining is the person's
 * own action, through `POST /api/join`, and opens the class.
 */
export const Route = createFileRoute('/_authed/join/$code')({ component: Join });

function Join() {
  usePageTitle('Join a class');
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const open = (classId: string) =>
    navigate({ to: '/classes/$classId/topics', params: { classId } });
  return (
    <main id="main" className={page.index}>
      <h1>Join a class</h1>
      <p>You join as a student with the invitation code from this link.</p>
      <JoinForm
        initialCode={code}
        onJoined={({ classId }) => void open(classId)}
        onDone={() => void navigate({ to: '/courses' })}
      />
    </main>
  );
}
