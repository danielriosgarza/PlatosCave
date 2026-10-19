import { noServer, runInServer } from '../host/compose';
import type { Command } from '../main';
import { setupDocument } from '../site/setup';

/**
 * `parallax apply` (docs/design/site.md §8): the setup document on the standard input of the
 * server's script, with the `.ts` that its entry-point guard needs. The script prints the
 * enrolment codes and join links once, to this terminal and nowhere else. Its exit code is the
 * command's: 1 or 2 has several causes, which its lines name.
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return noServer('apply');
  const document = JSON.stringify(setupDocument(site));
  const code = await runInServer(site, 'src/scripts/apply-site.ts', document);
  if (code !== 0) console.error(`parallax apply: exit code ${code}; the lines above say why.`);
  return code;
};
