import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { closure } from '../../../../packages/cli/scripts/vendor';

// .github/workflows/package-release.yml (docs/design/site.md §12, ADR-0001 "Release"): what keeps
// a pull request or a dry run from publishing, and the one job that publishes to what build checked.
const repo = resolve(import.meta.dirname, '../../../..');
const text = readFileSync(resolve(repo, '.github/workflows/package-release.yml'), 'utf8');
type Step = { name?: string; uses?: string; run?: string; env?: object; with?: { name?: string } };
type Job = { needs?: string; if?: string; permissions?: object; steps: Step[] };
const workflow = parse(text);
const { build, publish } = workflow.jobs as Record<'build' | 'publish', Job>;
const named = (job: Job, name: string) =>
  job.steps.find((step) => step.name === name || step.uses?.startsWith(name));
const [check, sums, push, npm] = [
  'The npm token is set',
  'Check what build handed over against the release manifest',
  'Push the images',
  'Publish the npm packages',
] as const;

describe('package-release.yml', () => {
  test('the workflow may read the repository; only publish may write packages', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'publish']);
    expect(build.permissions).toBeUndefined();
    expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' });
  });

  test('only publish names a secret: the GHCR token where it pushes, the npm token where it publishes', () => {
    const naming = publish.steps.filter((step) => JSON.stringify(step).includes('secrets.'));
    expect(naming.map((step) => step.name)).toEqual([check, push, npm]);
    // The first learns only whether the npm token is set, not its value.
    const set = `\${{ secrets.NPM_TOKEN != '' }}`;
    expect(named(publish, check)?.env).toEqual({ NPM_TOKEN_SET: set });
    expect(named(publish, check)?.run).toBe('test "$NPM_TOKEN_SET" = true');
    expect(JSON.stringify(naming[1])).toMatch(/secrets\.GITHUB_TOKEN(?!.*NPM_TOKEN)/);
    expect(JSON.stringify(naming[2])).toContain('secrets.NPM_TOKEN }}');
    expect(text.match(/secrets\./g)).toHaveLength(3);
  });

  test('publish runs only on the publish output, and builds and installs nothing', () => {
    expect([publish.needs, publish.if]).toEqual(['build', "needs.build.outputs.publish == 'true'"]);
    expect(workflow.jobs.build.outputs.publish).toBe(`\${{ steps.release.outputs.publish }}`);
    // No checkout, no Node or pnpm set up, no image built: the runner's docker, npm and jq only.
    const actions = publish.steps.flatMap((step) => step.uses?.replace(/@.*/, '') ?? []);
    expect(actions.every((uses) => /^actions\/(up|down)load-artifact$/.test(uses))).toBe(true);
    const building =
      /\b(docker (image )?build|buildx|build-push|npm (ci|install|i|run|exec)|pnpm|yarn|npx|tsx|node)\b/;
    for (const step of publish.steps) expect(step.run ?? '', step.name).not.toMatch(building);
  });

  test('publish pushes the image archives and the tarballs that build handed over', () => {
    const handed = named(build, 'actions/upload-artifact@')?.with?.name;
    expect(handed).toBe(`parallax-\${{ steps.release.outputs.version }}`);
    expect(named(publish, 'actions/download-artifact@')?.with?.name).toBe(
      handed?.replace('steps.release', 'needs.build'),
    );
    const run = (name: string) => named(publish, name)?.run ?? '';
    expect(run(push)).toMatch(/docker load --input "[^"]+"\n\s*docker push "\$ref"/);
    expect(run(npm)).toMatch(/in parallax-site create-parallax-site; do\n\s*npm publish /);
    // npm reads `release/x.tgz` as a GitHub repository: each file given to npm or docker is ./ or /.
    const given = publish.steps
      .map((step) => step.run ?? '')
      .flatMap((each) => [...each.matchAll(/(?:npm publish|docker load --input) "([^"]*)"/g)]);
    const files = ['./images/$name.tar', './release/$name-$VERSION.tgz'];
    expect(given.map((match) => match[1])).toEqual(files);
    expect(run(sums)).toMatch(/\(\.packages\[\], \.images\[\]\).*\| sha256sum -c --strict$/);
    // The token, then both checksums, then the images, then the npm packages (ADR-0001, Release).
    const order = [check, sums, push, npm].map((n) => publish.steps.findIndex((s) => s.name === n));
    expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);
  });

  test('a tag parallax-v* publishes; a manual run is a dry run unless dry_run is turned off', () => {
    expect(workflow.on.push).toEqual({ tags: ['parallax-v*'] });
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ default: true });
    expect(text).not.toContain('continue-on-error');
    expect(text).not.toMatch(/\|\|\s*true/);
  });

  test('a pull request that changes what the installed-package check runs starts the workflow', () => {
    // A GitHub paths pattern: `**` any path, `*` within one folder.
    const glob = (path: string) =>
      path.replace(/\*\*|\*|\./g, (part) => ({ '**': '.*', '*': '[^/]*' })[part] ?? '\\.');
    const paths: RegExp[] = workflow.on.pull_request.paths.map((p: string) =>
      RegExp(`^${glob(p)}$`),
    );
    // The workflow, the check and the conversion closure that vendor.ts packs.
    const packed = closure(resolve(repo, 'apps/server')).map((file) => `apps/server/${file}`);
    const own = ['.github/workflows/package-release.yml', 'packages/cli/scripts/packed-install.sh'];
    const files = [...own, ...packed];
    expect(files.filter((file) => !paths.some((path) => path.test(file)))).toEqual([]);
  });
});
