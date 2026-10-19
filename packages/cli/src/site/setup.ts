import { posix } from 'node:path';
import type { SiteSetup } from '@parallax/contracts';
import { loadSource } from '../paths';
import { type Site, SiteProblems } from './load';

const contracts = await loadSource<typeof import('@parallax/contracts')>(
  'contracts',
  'src/index.ts',
);

/**
 * The document `parallax apply` sends to the server (docs/design/site.md §8, `siteSetup`): the
 * listed instructor folders, each with its address and, for messages, the path of its
 * `instructor.yaml`, and the classes as the configuration has them. A class names its course by
 * the folder's listed name, which `loadSite` checked. The document is written to no file.
 */
export function setupDocument(site: Site): SiteSetup {
  const parsed = contracts.siteSetup.safeParse({
    appOrigin: site.config.origins.app,
    instructors: site.instructors.map(({ ref, path, meta }) => {
      return { ref, path: posix.join(path, 'instructor.yaml'), email: meta.email };
    }),
    classes: site.config.classes,
  });
  if (parsed.success) return parsed.data;
  const lines = contracts.siteIssueLines(parsed.error.issues);
  throw new SiteProblems(lines.map((line) => `setup document: ${line}`));
}
