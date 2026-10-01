import { type SessionClass, usableClasses, useSession } from './useSession';

/** The signed-in person's membership of `classId`, or undefined (not a member: show nothing). */
export function useClassContext(classId: string): SessionClass | undefined {
  const session = useSession();
  if (session.status !== 'signed-in') return undefined;
  return usableClasses(session.me).find((c) => c.classId === classId);
}
