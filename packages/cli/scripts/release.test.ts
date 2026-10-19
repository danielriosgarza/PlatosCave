import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { parse } from 'yaml';
import { decide, PACKAGES, ReleaseError, type Run, releaseManifest, stamp } from './release';

// The release rule of docs/design/site.md §12, on the functions the workflow runs: no network.
const repo = resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-release-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const read = (file: string) => fs.readFileSync(join(repo, file), 'utf8');
const sha = '3f9c2b7e1d4a5c6b8e9f0a1b2c3d4e5f6a7b8c9d';
const tag: Run = { event: 'push', refType: 'tag', refName: 'parallax-v1.4.0', sha, owner: 'Org-A' };
const run = (over: Partial<Run> = {}): Run => ({ ...tag, ...over });
const branch = { refType: 'branch', refName: 'claude/p5-22-release' };
const server = 'ghcr.io/org-a/parallax-server:1.4.0';

test('a tag parallax-v<version> publishes that version, the images under the owner on GHCR', () => {
  const images = { server, runner: server.replace('server', 'runner') };
  const release = { version: '1.4.0', publish: true, namespace: 'ghcr.io/org-a' };
  expect(decide(run())).toEqual({ ...release, images });
  expect(decide(run({ event: 'workflow_dispatch', dryRun: 'false' })).publish).toBe(true);
  expect(decide(run({ refName: 'parallax-v2.0.0-rc.1' })).version).toBe('2.0.0-rc.1');
});

test('a pull request, a manual run with dry_run and a manual run without a tag publish nothing', () => {
  const dryRun = { version: `0.0.0-dryrun.${sha}`, publish: false };
  expect(decide(run({ event: 'pull_request', ...branch }))).toMatchObject(dryRun);
  const manual = run({ event: 'workflow_dispatch', dryRun: 'true' });
  expect(decide(manual)).toMatchObject({ version: '1.4.0', publish: false });
  // `dry_run` holds unless it says false: a run that names none stays a dry run.
  expect(decide({ ...manual, dryRun: '' }).publish).toBe(false);
  expect(decide({ ...manual, dryRun: 'false', ...branch })).toMatchObject(dryRun);
});

test('a tag that is not parallax-v and a semantic version is refused', () => {
  const tags = ['vv1.0.0', '1.0', '01.0.0', '1.0.0-', '1.0.0-rc.01', '1.0.0+build.1', '1.0.0\n'];
  for (const refName of [...tags.map((v) => `parallax-v${v}`), 'connector-v1.0.0']) {
    expect(() => decide(run({ refName })), refName).toThrow(ReleaseError);
  }
  expect(() => decide(run({ ...branch, sha: '' }))).toThrow(ReleaseError);
  expect(() => decide(run({ owner: 'own/er' }))).toThrow(ReleaseError);
});

test('both manifests and both image labels get the one version', () => {
  const { engines } = JSON.parse(read('package.json'));
  for (const dir of Object.values(PACKAGES)) {
    // In the repository: 0.0.0, publishable, and the root's Node version (ADR-0001).
    const tracked = JSON.parse(read(`${dir}/package.json`));
    expect(tracked).toMatchObject({ version: '0.0.0', engines });
    expect(tracked.publishConfig).toMatchObject({ access: 'public' });
    expect(tracked).not.toHaveProperty('private');
    fs.cpSync(join(repo, dir, 'package.json'), join(temp, dir, 'package.json'));
  }
  stamp(decide(run({ refName: 'parallax-v1.4.0-rc.2' })), temp);
  const [tool, scaffolder] = Object.values(PACKAGES).map((dir) =>
    JSON.parse(fs.readFileSync(join(temp, dir, 'package.json'), 'utf8')),
  );
  expect([tool.version, scaffolder.version]).toEqual(['1.4.0-rc.2', '1.4.0-rc.2']);
  expect(tool.parallax).toEqual({ registry: 'ghcr.io/org-a' });
  // A site's pages need React's types, which the scaffolded site gets from the tool alone.
  const types = { '@types/react': '19.3.0', '@types/react-dom': '19.3.0' };
  expect(tool.dependencies).toMatchObject(types);
  const label =
    /^ARG PARALLAX_VERSION=0\.0\.0\nLABEL org\.opencontainers\.image\.version="\$\{PARALLAX_VERSION\}"$/m;
  for (const name of ['server', 'runner'])
    expect(read(`infra/docker/${name}.Dockerfile`)).toMatch(label);
  type Step = { id?: string; uses?: string; run?: string; with?: object };
  const steps: Step[] = parse(read('.github/workflows/package-release.yml')).jobs.build.steps;
  expect(steps.find((step) => step.id === 'release')?.run).toContain('release.ts decide');
  const output = (name: string) => `\${{ steps.release.outputs.${name} }}`;
  const images = steps.filter((step) => step.uses?.startsWith('docker/build-push-action@'));
  expect(images.map((step) => step.with)).toEqual(
    ['server', 'runner'].map((name) =>
      expect.objectContaining({
        file: `infra/docker/${name}.Dockerfile`,
        'build-args': `PARALLAX_VERSION=${output('version')}`,
        tags: output(`${name}_image`),
        push: false,
      }),
    ),
  );
});

test('the release manifest holds the checksums of the tarballs, the images and the revision', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const packages = Object.fromEntries(
    Object.keys(PACKAGES).map((name) => {
      fs.writeFileSync(join(temp, `${name}-1.4.0.tgz`), name);
      return [name, { file: `${name}-1.4.0.tgz`, sha256: sha256(name) }];
    }),
  );
  const runner = server.replace('server', 'runner');
  const images = { 'parallax-server': { ref: server }, 'parallax-runner': { ref: runner } };
  const manifest = releaseManifest(decide(run()), temp, sha);
  expect(manifest).toEqual({ version: '1.4.0', revision: sha, packages, images });
});
