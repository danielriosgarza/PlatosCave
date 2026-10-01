import { createFileRoute } from '@tanstack/react-router';
import { TopicIndex } from '../../topics/TopicIndex';

export const Route = createFileRoute('/_authed/classes/$classId/topics/')({ component: Topics });

function Topics() {
  const { classId } = Route.useParams();
  return <TopicIndex classId={classId} />;
}
