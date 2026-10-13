import type { SiteConfigInput } from '@parallax/contracts';

/** Gives the editor the type of a site's configuration; `parallax.config.ts` exports the result. */
export function defineConfig(config: SiteConfigInput): SiteConfigInput {
  return config;
}
