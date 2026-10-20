import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from '../src/digest';

// `release.ts decide|stamp|manifest <folder>` (docs/design/site.md §12): each command reads the run
// from the GITHUB_* variables and DRY_RUN (`dry_run`), so each step takes the same decision.

/** The two npm packages by name, with their folders (§2). */
export const PACKAGES = {
  'parallax-site': 'packages/cli',
  'create-parallax-site': 'packages/create-parallax-site',
} as const;
/** semver.org 2.0.0 as a Docker tag holds it: no build metadata (`+`), at most 128 characters. */
const SEMVER =
  /^(?=.{5,128}$)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

/** The run as GitHub Actions describes it; `dryRun` is the input `dry_run` as text. */
export type Run = Record<'event' | 'refType' | 'refName' | 'sha' | 'owner', string> & {
  dryRun?: string;
};
export type Release = ReturnType<typeof decide>;
export class ReleaseError extends Error {}

/**
 * connector-release.yml's rule: a tag's version, or `0.0.0-dryrun.<sha>` and no publishing. A tag
 * push publishes, a manual run on a tag only with `dry_run` false, a pull request never.
 */
export function decide(run: Run) {
  const tag = run.refType === 'tag' ? /^parallax-v(.*)$/s.exec(run.refName) : undefined;
  if (tag === null) throw new ReleaseError(`The tag ${run.refName} is not parallax-v<version>`);
  if (!tag && !/^[0-9a-f]{40}$/.test(run.sha)) throw new ReleaseError(`No commit: ${run.sha}`);
  const version = tag ? (tag[1] ?? '') : `0.0.0-dryrun.${run.sha}`;
  if (!SEMVER.test(version)) throw new ReleaseError(`${version} is not a semantic version`);
  if (!/^[a-z0-9](-?[a-z0-9])*$/i.test(run.owner)) throw new ReleaseError(`No owner: ${run.owner}`);
  const manual = run.event === 'workflow_dispatch' && run.dryRun === 'false';
  const publish = Boolean(tag) && (run.event === 'push' || manual);
  const namespace = `ghcr.io/${run.owner.toLowerCase()}`;
  const image = (name: string) => `${namespace}/parallax-${name}:${version}`;
  const images = { server: image('server'), runner: image('runner') };
  return { version, publish, namespace, images };
}

/** Stamps the version into both manifests under `root`, the namespace into parallax-site's. */
export function stamp(release: Release, root = resolve(import.meta.dirname, '../../..')): void {
  for (const [name, dir] of Object.entries(PACKAGES)) {
    const file = join(root, dir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.version = release.version;
    if (name === 'parallax-site')
      manifest.parallax = { ...manifest.parallax, registry: release.namespace };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/**
 * What build hands over in `folder`, each file with its checksum; `publish` adds the digests. An
 * image archive is hashed part by part, since it may pass the 2 GiB that readFileSync returns.
 */
export function releaseManifest(release: Release, folder: string, revision: string) {
  const sum = (file: string) => ({ file, sha256: fileDigest(join(folder, file)).sha256 });
  const tarball = (name: string) => sum(`release/${name}-${release.version}.tgz`);
  const packages = Object.fromEntries(Object.keys(PACKAGES).map((name) => [name, tarball(name)]));
  const images = Object.entries(release.images).map(([name, ref]) => {
    return [`parallax-${name}`, { ref, ...sum(`images/parallax-${name}.tar`) }];
  });
  return { version: release.version, revision, packages, images: Object.fromEntries(images) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, folder] = process.argv.slice(2);
  const { env } = process;
  try {
    const release = decide({
      event: env.GITHUB_EVENT_NAME ?? '',
      refType: env.GITHUB_REF_TYPE ?? '',
      refName: env.GITHUB_REF_NAME ?? '',
      sha: env.GITHUB_SHA ?? '',
      owner: env.GITHUB_REPOSITORY_OWNER ?? '',
      dryRun: env.DRY_RUN,
    });
    if (command === 'decide') {
      console.log(`version=${release.version}\npublish=${release.publish}`);
      for (const [name, ref] of Object.entries(release.images)) console.log(`${name}_image=${ref}`);
    } else if (command === 'stamp') stamp(release);
    else if (command === 'manifest' && folder) {
      const manifest = releaseManifest(release, folder, env.GITHUB_SHA ?? '');
      fs.writeFileSync(join(folder, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    } else throw new ReleaseError('usage: release.ts decide|stamp|manifest <folder>');
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
