import type { Me } from '../session/useSession';

type CourseGrant = Me['courses'][number];

/**
 * The person's permission on a course, named from the strongest grant (§3): owners hold every
 * authoring permission; an editor may also be a publisher.
 */
export function grantLabel(grant: Pick<CourseGrant, 'owner' | 'editor' | 'publisher'>): string {
  if (grant.owner) return 'Owner';
  if (grant.editor && grant.publisher) return 'Editor and publisher';
  return grant.publisher ? 'Publisher' : 'Editor';
}

/** Whether the person may publish a release of the course (owner or delegated publisher). */
export const canPublish = (grant: Pick<CourseGrant, 'owner' | 'publisher'>): boolean =>
  grant.owner || grant.publisher;

/** Whether the person may edit course drafts (owner or editor). */
export const canEdit = (grant: Pick<CourseGrant, 'owner' | 'editor'>): boolean =>
  grant.owner || grant.editor;
