import * as fs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const src = resolve(import.meta.dirname, '..');
const server = resolve(src, '../../../apps/server');
const driver = /^(pg|drizzle-orm|@parallax\/server)(\/|$)/;

test('no file of the reader or of check imports a database driver or a file of the server', () => {
  // The import specifiers, followed through the relative ones. A source the tool loads when it
  // runs (paths.ts) is no specifier: P5-08c loads the validator so, which imports no driver.
  const files = [...fs.readdirSync(join(src, 'folder')).map((name) => join(src, 'folder', name))];
  files.push(join(src, 'commands/check.ts'));
  const named: string[] = [];
  for (const file of files) {
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of importedFiles) {
      const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : '';
      const inServer = target !== '' && !relative(server, target).startsWith('..');
      if (driver.test(specifier) || inServer) named.push(`${relative(src, file)}: ${specifier}`);
      const next = target && (fs.existsSync(target) ? target : `${target}.ts`);
      if (next && fs.existsSync(next) && !files.includes(next)) files.push(next);
    }
  }
  expect(named).toEqual([]);
  expect(files.map((file) => relative(src, file).replaceAll('\\', '/'))).toEqual(
    expect.arrayContaining(['folder/read.ts', 'commands/check.ts', 'site/load.ts', 'paths.ts']),
  );
});
