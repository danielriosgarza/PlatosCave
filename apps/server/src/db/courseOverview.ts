import { desc, eq } from 'drizzle-orm';
import type { CourseScope } from '../auth/scope';
import type { Db } from './client';
import { classes, courseReleases, courses } from './schema';
import { forCourse } from './scoped';

/**
 * The course editors' overview (§12): the title, the newest release and, for each class, the
 * release it currently uses. Reads only the scope's course; never a draft.
 */
export async function courseOverview(db: Db, scope: CourseScope) {
  const [course] = await db.select().from(courses).where(eq(courses.id, scope.courseId));
  if (!course) return undefined;
  const releases = await db
    .select({
      id: courseReleases.id,
      version: courseReleases.version,
      createdAt: courseReleases.createdAt,
    })
    .from(courseReleases)
    .where(forCourse(scope, courseReleases))
    .orderBy(desc(courseReleases.version));
  const classRows = await db
    .select({
      id: classes.id,
      name: classes.name,
      archivedAt: classes.archivedAt,
      releaseId: classes.releaseId,
    })
    .from(classes)
    .where(forCourse(scope, classes))
    .orderBy(classes.name);
  const byId = new Map(releases.map((r) => [r.id, r]));
  const latest = releases[0];
  return {
    id: course.id,
    title: course.title,
    archived: course.archivedAt !== null,
    latestRelease: latest
      ? { id: latest.id, version: latest.version, createdAt: latest.createdAt.toISOString() }
      : null,
    classes: classRows.map((c) => {
      const release = c.releaseId ? byId.get(c.releaseId) : undefined;
      return {
        id: c.id,
        name: c.name,
        archived: c.archivedAt !== null || course.archivedAt !== null,
        release: release ? { id: release.id, version: release.version } : null,
      };
    }),
  };
}
