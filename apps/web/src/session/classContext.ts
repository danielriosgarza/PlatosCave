import { type SessionClass, useSession } from './useSession';

/** The signed-in person's membership of `classId`, or undefined (not a member: show nothing). */
export function useClassContext(classId: string): SessionClass | undefined {
  const session = useSession();
  if (session.status !== 'signed-in') return undefined;
  return session.me.classes.find((c) => c.classId === classId && !c.isPreview);
}
