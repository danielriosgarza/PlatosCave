import { createFileRoute } from '@tanstack/react-router';
import { ClassReview } from '../../review/ClassReview';
import { parseReviewSearch } from '../../review/classReview';

export const Route = createFileRoute('/_authed/classes/$classId/review')({
  validateSearch: parseReviewSearch,
  component: Review,
});

function Review() {
  const { classId } = Route.useParams();
  return <ClassReview classId={classId} search={Route.useSearch()} />;
}
