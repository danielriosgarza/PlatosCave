import { exerciseProblems, type ResourceType, shinyContentProblem } from '@parallax/contracts';
import type { validationIssue, validationReport } from '@parallax/contracts/routes/releases';
import type { z } from 'zod';
import type { RunnerRuntime } from '../config';
import { testPublicationIssues } from '../execution/publication';
import { type DerivedStatus, derivedReady } from './derived-status';

/**
 * The publication checks of a course's drafts (§12, ADR-0003), without a database: nothing this
 * module imports lies under `db/` or `auth/`, so `parallax check` can load it where there is no
 * server (docs/design/course-folder.md §8). `db/content/releases.ts` loads the drafts and calls it.
 */

type Issue = z.infer<typeof validationIssue>;
export type ValidationReport = z.infer<typeof validationReport>;

/** Types whose material is not text, so they need an accessible alternative (§7, §14). */
const needsAlternative = new Set<ResourceType>(['slides_pdf', 'reading_pdf', 'shiny']);

/** Whether a Shiny revision's address is on the host's approved list, as `loadShiny` decides. */
function shinyOriginApproved(content: unknown, approved: readonly string[]): boolean {
  const address = (content as { url?: unknown } | null)?.url;
  if (typeof address !== 'string' || shinyContentProblem(content)) return false;
  return approved.includes(new URL(address).origin);
}

/**
 * What `validate` reads of the drafts `loadDrafts` (`db/content/releases.ts`) returns: the live
 * topics with their resources, head revisions and each head revision's derived status.
 */
export type Drafts = readonly {
  topic: { id: string; title: string; prerequisites: readonly string[] };
  resources: readonly {
    resource: { id: string; courseId: string; type: ResourceType; title: string };
    revision: {
      resourceId: string;
      courseId: string;
      type: ResourceType;
      content: unknown;
      derived: Record<string, unknown>;
      accessibleAlternative: unknown;
    } | null;
    status: Pick<DerivedStatus, 'state'> | null;
  }[];
}[];

export interface ValidateOptions {
  approvedShinyOrigins?: readonly string[];
  /** The runtimes a code question may select: the configured `RUNNER_RUNTIMES`. */
  runtimes: readonly RunnerRuntime[];
}

/**
 * Publication checks (§12, ADR-0003): broken references, missing alternatives and unconverted
 * decks, exercise definitions, tests (grading rules and execution configuration, P3-18), and
 * Shiny apps whose origin the host has not approved (students would see only the preview label
 * and the external route, §10.7).
 */
export function validate(
  drafts: Drafts,
  { approvedShinyOrigins = [], runtimes }: ValidateOptions,
): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (drafts.length === 0) {
    errors.push({
      code: 'empty_release',
      message: 'The course has no topics to publish',
    });
  }
  const topicIds = new Set(drafts.map((d) => d.topic.id));
  for (const { topic, resources: items } of drafts) {
    const topicId = topic.id;
    for (const prerequisite of topic.prerequisites) {
      if (!topicIds.has(prerequisite)) {
        errors.push({
          code: 'broken_reference',
          message: `“${topic.title}” requires a topic that is not in this release`,
          topicId,
        });
      }
    }
    if (items.length === 0) {
      warnings.push({
        code: 'empty_topic',
        message: `“${topic.title}” has no resources`,
        topicId,
      });
    }
    for (const { resource, revision, status } of items) {
      const at = { topicId, resourceId: resource.id };
      if (!revision) {
        errors.push({
          code: 'no_revision',
          message: `“${resource.title}” has no content`,
          ...at,
        });
        continue;
      }
      // Nothing in the schema ties a head revision to its resource; the immutability
      // triggers would make a wrong pin permanent, so check before snapshotting.
      if (revision.resourceId !== resource.id || revision.courseId !== resource.courseId) {
        errors.push({
          code: 'broken_reference',
          message: `“${resource.title}” points at another resource’s revision`,
          ...at,
        });
        continue;
      }
      // The release tab comes from the revision type, so a mismatch would pin it in the wrong tab.
      if (revision.type !== resource.type) {
        errors.push({
          code: 'broken_reference',
          message: `“${resource.title}” has content of another resource type`,
          ...at,
        });
        continue;
      }
      if (revision.type === 'slides_pdf' && !derivedReady(revision.derived)) {
        const failed = status?.state === 'failed';
        errors.push({
          code: 'unconverted_deck',
          message: failed
            ? `“${resource.title}” could not be processed; upload it again or retry`
            : `“${resource.title}” has not been converted for viewing`,
          ...at,
        });
      }
      if (
        revision.type === 'reading_native' ||
        revision.type === 'reading_pdf' ||
        revision.type === 'slides_web' ||
        revision.type === 'notebook'
      ) {
        // A reading, web deck or notebook nobody can open is worse than none: block while its job is
        // unfinished or failed. A revision with no job on record (older data) is left alone.
        const state = status?.state;
        if (state !== undefined && state !== 'ready') {
          errors.push({
            code: 'unprocessed_reading',
            message:
              state === 'failed'
                ? `“${resource.title}” could not be processed; ${
                    revision.type === 'slides_web' ? 'edit it' : 'upload it again'
                  } or retry`
                : `“${resource.title}” is still being processed`,
            ...at,
          });
        }
      }
      if (revision.type === 'exercise') {
        for (const problem of exerciseProblems(revision.content)) {
          errors.push({
            code: 'invalid_exercise',
            message: `“${resource.title}”: ${problem}`,
            ...at,
          });
        }
      }
      if (revision.type === 'test') {
        const found = testPublicationIssues(revision.content, runtimes);
        for (const { code, message } of found.errors) {
          errors.push({ code, message: `“${resource.title}”: ${message}`, ...at });
        }
        for (const { code, message } of found.warnings) {
          warnings.push({ code, message: `“${resource.title}”: ${message}`, ...at });
        }
      }
      if (
        revision.type === 'shiny' &&
        !shinyOriginApproved(revision.content, approvedShinyOrigins)
      ) {
        warnings.push({
          code: 'unapproved_shiny_origin',
          message: `“${resource.title}” is not on an approved Shiny origin; students will see “Preview · no session”`,
          ...at,
        });
      }
      if (needsAlternative.has(revision.type) && !revision.accessibleAlternative) {
        const rasterDeck = revision.type === 'slides_pdf' && revision.derived.rasterOnly === true;
        (rasterDeck ? errors : warnings).push({
          code: 'missing_alternative',
          message: `“${resource.title}” has no accessible alternative`,
          ...at,
        });
      }
    }
  }
  return { errors, warnings };
}
