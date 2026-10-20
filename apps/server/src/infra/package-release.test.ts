import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { closure } from '../../../../packages/cli/scripts/vendor';

// .github/workflows/package-release.yml (docs/design/site.md §12, ADR-0001 "Release"): what keeps
// a pull request or a dry run from publishing, and the one job that publishes to what build checked.
const repo = resolve(import.meta.dirname, '../../../..');
const text = readFileSync(resolve(repo, '.github/workflows/package-release.yml'), 'utf8');
type Step = { name?: string; uses?: string; run?: string; env?: object; with?: { name?: string } };
type Job = {
  needs?: string;
  if?: string;
  environment?: string;
  permissions?: object;
  steps: Step[];
};
const workflow = parse(text);
const { build, publish } = workflow.jobs as Record<'build' | 'publish', Job>;
const named = (job: Job, name: string) =>
  job.steps.find((step) => step.name === name || step.uses?.startsWith(name));
const [check, sums, unpublished, push, npm] = [
  'The npm token is set',
  'Check what build handed over against the release manifest',
  'The version is not published yet',
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

  test('only publish names a secret: the GHCR token where it checks and pushes, the npm token where it publishes', () => {
    const naming = publish.steps.filter((step) => JSON.stringify(step).includes('secrets.'));
    expect(naming.map((step) => step.name)).toEqual([check, unpublished, push, npm]);
    // The first learns only whether the npm token is set, not its value.
    const set = `\${{ secrets.NPM_TOKEN != '' }}`;
    expect(named(publish, check)?.env).toEqual({ NPM_TOKEN_SET: set });
    expect(named(publish, check)?.run).toBe('test "$NPM_TOKEN_SET" = true');
    for (const step of naming.slice(1, 3))
      expect(JSON.stringify(step)).toMatch(/secrets\.GITHUB_TOKEN(?!.*NPM_TOKEN)/);
    expect(JSON.stringify(naming[3])).toContain('secrets.NPM_TOKEN }}');
    expect(text.match(/secrets\./g)).toHaveLength(4);
  });

  test('the npm token is a secret of the environment release, which only publish names', () => {
    // The environment allows parallax-v* tags only (docs/operations.md): a pull request's run of
    // an edited copy of this file cannot read its secrets.
    expect(publish.environment).toBe('release');
    expect(Object.hasOwn(build, 'environment')).toBe(false);
    expect(text.match(/^\s*environment:/gm)).toHaveLength(1);
  });

  test('the release manifest is uploaded also when a step fails, with the digests pushed so far', () => {
    const last = publish.steps.at(-1) as Step & { if?: string; with?: { path?: string } };
    expect(last.uses).toMatch(/^actions\/upload-artifact@/);
    expect([last.if, last.with?.path]).toEqual(['always()', 'release.json']);
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
    // The token, then both checksums, then that nothing of the version is published, then the
    // images, then the npm packages (ADR-0001, Release).
    const steps = [check, sums, unpublished, push, npm];
    const order = steps.map((n) => publish.steps.findIndex((s) => s.name === n));
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

// The step's own script, run by bash as GitHub runs it (`bash -eo pipefail`), against stub npm and
// curl that answer as the registries do. CI's runners have bash and jq; a machine without them
// skips these cases.
const shellReady = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const STUB_NPM = `#!/usr/bin/env bash
case "$NPM_CASE" in
  absent) printf 'npm error code E404\nnpm error 404 No match found\n' >&2; exit 1 ;;
  published) printf '%s\n' "\${2#*@}" ;;
  warned) echo 'npm warn config the setting is deprecated' >&2 ;;
  offline) echo 'npm error code ETIMEDOUT' >&2; exit 1 ;;
esac
`;
const STUB_CURL = `#!/usr/bin/env bash
config="$(cat)"
printf '%s\n' "$*" >> "$STUB_LOG/argv"
printf '%s\n' "$config" >> "$STUB_LOG/stdin"
url="\${*: -1}" out='' previous=''
for arg in "$@"; do [[ "$previous" == --output ]] && out="$arg"; previous="$arg"; done
if [[ "$url" == *'/token?'* ]]; then
  if [[ "$TOKEN_CASE" == refused ]]; then echo 'curl: (22) The requested URL returned error: 403' >&2; exit 22; fi
  echo '{"token":"bearer-from-ghcr"}'
  exit 0
fi
case "$GHCR_CASE" in
  absent) echo '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}' > "$out"; printf 404 ;;
  new) echo '{"errors":[{"code":"NAME_UNKNOWN","message":"name unknown"}]}' > "$out"; printf 404 ;;
  published) echo '{"schemaVersion":2}' > "$out"; printf 200 ;;
  denied) echo '{"errors":[{"code":"DENIED","message":"denied"}]}' > "$out"; printf 403 ;;
  page) echo '<html>not found</html>' > "$out"; printf 404 ;;
esac
`;

describe.skipIf(!shellReady)(
  'The version is not published yet, run against stub registries',
  () => {
    const script = named(publish, unpublished)?.run ?? '';
    const VERSION = '0.1.0-rc.1';
    const refs = ['server', 'runner'].map((name) => `ghcr.io/org-a/parallax-${name}:${VERSION}`);
    const runStep = (npmCase: string, ghcrCase: string, tokenCase = 'granted') => {
      const dir = mkdtempSync(join(tmpdir(), 'parallax-unpublished-'));
      try {
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        for (const [name, body] of [
          ['npm', STUB_NPM],
          ['curl', STUB_CURL],
        ] as const) {
          writeFileSync(join(bin, name), body);
          chmodSync(join(bin, name), 0o755);
        }
        writeFileSync(join(dir, 'step.sh'), script);
        const images = Object.fromEntries(
          refs.map((ref, i) => [`parallax-${['server', 'runner'][i]}`, { ref }]),
        );
        writeFileSync(join(dir, 'release.json'), JSON.stringify({ images }));
        const env = {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          VERSION,
          GITHUB_ACTOR: 'owner-a',
          GHCR_TOKEN: 'secret-ghcr-token',
          RUNNER_TEMP: dir,
          STUB_LOG: dir,
          NPM_CASE: npmCase,
          GHCR_CASE: ghcrCase,
          TOKEN_CASE: tokenCase,
        };
        const shell = ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')];
        const done = spawnSync('bash', shell, { cwd: dir, env, encoding: 'utf8' });
        const log = (name: string) =>
          existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
        return {
          status: done.status,
          output: done.stdout + done.stderr,
          argv: log('argv'),
          stdin: log('stdin'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('a version that neither registry has goes on, and a warning from npm is not a version', () => {
      for (const [npmCase, ghcrCase] of [
        ['absent', 'absent'],
        ['warned', 'new'],
      ] as const) {
        const { status, output, argv } = runStep(npmCase, ghcrCase);
        // It prints nothing but the mask of each image's bearer, which GitHub does not mask itself.
        const masks = '::add-mask::bearer-from-ghcr\n'.repeat(refs.length);
        expect([status, output], `${npmCase} ${ghcrCase}`).toEqual([0, masks]);
        // Both images were asked for, each at the version.
        for (const ref of refs) {
          const [repo] = ref.replace('ghcr.io/', '').split(':');
          expect(argv).toContain(`https://ghcr.io/v2/${repo}/manifests/${VERSION}`);
        }
      }
    });

    test('a version that npm or GHCR has stops the run, and so does any answer but not found', () => {
      const cases = [
        ['published', 'absent', 'granted', `::error::parallax-site@${VERSION} is already on npm`],
        [
          'offline',
          'absent',
          'granted',
          `::error::npm could not say whether parallax-site@${VERSION} is published`,
        ],
        ['absent', 'published', 'granted', `::error::${refs[0]} is already on GHCR`],
        ['absent', 'denied', 'granted', `::error::GHCR answered 403 for ${refs[0]}`],
        ['absent', 'page', 'granted', `::error::GHCR answered 404 for ${refs[0]}`],
        ['absent', 'absent', 'refused', `::error::GHCR refused a token to push ${refs[0]}`],
      ];
      for (const [npmCase, ghcrCase, tokenCase, error] of cases) {
        const { status, output } = runStep(npmCase as string, ghcrCase as string, tokenCase);
        expect(status, `${npmCase} ${ghcrCase} ${tokenCase}`).toBe(1);
        expect(output, `${npmCase} ${ghcrCase} ${tokenCase}`).toContain(error);
      }
    });

    test('the GHCR credential and the bearer reach curl on its standard input, never its command line', () => {
      const { status, argv, stdin } = runStep('absent', 'absent');
      expect(status).toBe(0);
      for (const secret of ['secret-ghcr-token', 'bearer-from-ghcr']) {
        expect(argv).not.toContain(secret);
        expect(stdin).toContain(secret);
      }
      // Each request is bounded in time and retried.
      for (const line of argv.trim().split('\n')) expect(line).toMatch(/--max-time 30 --retry 3/);
    });
  },
);
