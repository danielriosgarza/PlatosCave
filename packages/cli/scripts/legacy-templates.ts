import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSource } from '../src/paths';

// `tsx packages/cli/scripts/legacy-templates.ts <version>…` (docs/design/site.md §10.1): writes
// `src/site/legacy-templates.json`, the fingerprints of the files a new site of either mode got
// from each named version of the published scaffolder, which `parallax update` compares a site
// with when it has no record. The versions are the ones published before the scaffolder wrote a
// record: 0.1.0-rc.1, 0.1.0 and 0.1.1. It needs the npm registry.

const MODES = ['instructor', 'school'] as const;
const windows = process.platform === 'win32';

type Scaffold = { fingerprints(dir: string): Record<string, string> };

/** Each version's fingerprints by mode, from its scaffolder as npm delivers it. */
export async function legacyTemplates(versions: string[]) {
  const { fingerprints } = await loadSource<Scaffold>('scaffold', 'src/create.mjs');
  const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-legacy-'));
  try {
    return Object.fromEntries(
      versions.map((version) => {
        const at = join(temp, version);
        fs.mkdirSync(at);
        const options = { cwd: at, encoding: 'utf8', shell: windows, stdio: 'pipe' } as const;
        const tarball = execFileSync('npm', ['pack', `create-parallax-site@${version}`], options);
        execFileSync('tar', ['-xzf', tarball.trim().split('\n').at(-1) ?? ''], options);
        const bin = join(at, 'package/bin/create-parallax-site.mjs');
        const modes = MODES.map((mode) => {
          execFileSync(process.execPath, [bin, mode, '--template', mode], {
            ...options,
            shell: false,
          });
          return [mode, fingerprints(join(at, mode))];
        });
        return [version, Object.fromEntries(modes)];
      }),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const versions = process.argv.slice(2);
  if (versions.length === 0) {
    console.error('usage: tsx packages/cli/scripts/legacy-templates.ts <version>…');
    process.exitCode = 2;
  } else {
    const out = join(import.meta.dirname, '../src/site/legacy-templates.json');
    fs.writeFileSync(out, `${JSON.stringify(await legacyTemplates(versions), null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}
