import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `tsx packages/cli/scripts/pack.ts <package> <version> <folder>` (docs/design/site.md §2): a
// stamped tarball for a test or the release workflow, with no change to a tracked manifest.

const repository = resolve(import.meta.dirname, '../../..');

/** The folder under `packages/` of the workspace package whose manifest is named `name`. */
function folderOf(name: string): string {
  for (const dir of fs.readdirSync(join(repository, 'packages'))) {
    const file = join(repository, 'packages', dir, 'package.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).name === name) {
      return join(repository, 'packages', dir);
    }
  }
  throw new Error(`No package under packages/ is named ${name}`);
}

/**
 * Stages the package in a temporary folder (its manifest, `scripts/` and what `files` names),
 * stamps `version` there and runs `npm pack`, which runs `prepack` first; the tarball is put into
 * `folder` and its path returned. The staged manifest keeps no `devDependencies`: a published
 * package installs none, and `workspace:` means nothing outside the workspace.
 */
export function pack(name: string, version: string, folder: string): string {
  const source = folderOf(name);
  const manifest = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8'));
  const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-stage-'));
  const stage = join(temp, 'package');
  try {
    const named: string[] = (manifest.files ?? []).filter(
      (entry: string) => !entry.startsWith('!'),
    );
    for (const entry of ['scripts', ...named].filter((each) => fs.existsSync(join(source, each)))) {
      fs.cpSync(join(source, entry), join(stage, entry), { recursive: true });
    }
    manifest.version = version;
    delete manifest.devDependencies;
    fs.writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // `prepack` runs the package's own tsx and reads the sources from this repository.
    const path = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const bin = [join(source, 'node_modules/.bin'), process.env[path]].join(delimiter);
    const env = { ...process.env, [path]: bin, PARALLAX_REPOSITORY: repository };
    const windows = process.platform === 'win32';
    execFileSync('npm', ['pack', '--ignore-scripts=false'], {
      cwd: stage,
      env,
      stdio: 'pipe',
      shell: windows,
    });
    const tarball = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(join(stage, tarball), join(folder, tarball));
    return join(folder, tarball);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, version, folder] = process.argv.slice(2);
  if (!name || !version || !folder) {
    console.error('usage: tsx packages/cli/scripts/pack.ts <package> <version> <folder>');
    process.exitCode = 2;
  } else console.log(pack(name, version, resolve(folder)));
}
