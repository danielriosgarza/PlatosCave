import { noServer } from '../host/compose';
import { writeSiteEnv } from '../host/siteEnv';
import type { Command } from '../main';

/** `parallax env` (docs/design/site.md §5, §9, §11). It names what it adds and prints no secret. */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return noServer('env');
  const { added, pulls } = writeSiteEnv(site);
  const two = pulls.length > 0 ? ', .parallax/pg_hba.conf and .parallax/runner/runner.env' : '';
  const env = added.length > 0 ? `.env gained ${added.join(', ')}` : '.env is as it was';
  console.error(`parallax env: wrote .parallax/site.env${two}; ${env}.`);
  if (two) console.error(['Pull on the runner host, before it starts:', ...pulls].join('\n  '));
  return 0;
};
