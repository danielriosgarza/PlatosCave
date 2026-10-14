import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { type ConvertSource, convertRevision, IngestError } from './convert';
import { renderReading } from './reading';

const src = resolve(import.meta.dirname, '..');
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** What `entry` reaches through relative imports and thread scripts: files from `src/`, packages. */
function importClosure(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages: string[] = [];
  const follow = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, spec = ''] of code.matchAll(/(?:from|import|new URL)\s*\(?\s*['"]([^'"]+)/g)) {
      if (!spec.startsWith('.')) packages.push(spec);
      else {
        const base = resolve(dirname(file), spec);
        const target = [`${base}.ts`, resolve(base, 'index.ts'), base].find(isFile);
        if (!target) throw new Error(`${file} imports ${spec}, which is no file`);
        follow(target);
      }
    }
  };
  follow(resolve(src, entry));
  return { files: [...seen].map((file) => relative(src, file).replaceAll('\\', '/')), packages };
}

const markdown = '# Reef zones\n\nThe reef flat lies between the lagoon and the crest.';

describe('conversion without a database (P5-09)', () => {
  test('A40 conversion runs with DATABASE_URL unset and imports no database module', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      vi.resetModules();
      const entry: typeof import('./convert') = await import('./convert');
      const source = { type: 'reading_native', content: { sourceKey: 'k', format: 'markdown' } };
      const read = async () => new TextEncoder().encode(markdown);
      expect(
        await entry.convertRevision({ ...source, objectKeys: ['k'] } as ConvertSource, { read }),
      ).toEqual({ derived: renderReading(markdown, 'markdown', {}), objects: [] });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
    const { files, packages } = importClosure('content/convert.ts');
    // The walk went into each thread script and the module it loads.
    const workers = ['notebook', 'pdf-text', 'reading'].map((name) => `content/${name}.worker.mjs`);
    const loaded = ['content/notebook.ts', 'content/reading.ts'];
    expect(files).toEqual(expect.arrayContaining([...loaded, ...workers]));
    expect(files.filter((file) => file.startsWith('db/'))).toEqual([]);
    expect(packages.filter((name) => /^(pg|pg-boss|drizzle-orm)(\/|$)/.test(name))).toEqual([]);
  });

  test('A40 conversion preserves bounded rendering and omits JavaScript outputs', async () => {
    const script = 'window.reefScriptRan = true';
    const html = `<p>Transect survey</p><script>${script}</script>`;
    const display = (data: object) => ({ output_type: 'display_data', metadata: {}, data });
    const outputs = [
      display({ 'application/javascript': script }),
      display({ 'application/javascript': script, 'text/html': html }),
    ];
    const cell = { id: 'survey', cell_type: 'code', metadata: {}, execution_count: 1, source: '' };
    const nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ ...cell, outputs }] };
    const io = { read: async () => new TextEncoder().encode(JSON.stringify(nb)), prefix: 'c' };
    const sources: ConvertSource[] = [
      { type: 'reading_native', content: { markdown }, objectKeys: [] },
      { type: 'slides_web', content: { markdown }, objectKeys: [] },
      { type: 'notebook', content: { sourceKey: 'nb' }, objectKeys: ['nb'] },
    ];
    // An aborted signal stops each conversion as it stops its thread: a retry, not a failed file.
    for (const source of sources) {
      const stopped = { ...io, signal: AbortSignal.abort() };
      const err = await convertRevision(source, stopped).catch((e: unknown) => e);
      expect(err).toEqual(new Error('The work was stopped before it finished'));
      expect(err).not.toBeInstanceOf(IngestError);
    }

    const { derived, objects } = await convertRevision(sources[2] as ConvertSource, io);
    const stored = JSON.stringify(derived.notebook);
    expect(stored).toMatch(/"type":"unsupported".*"type":"html"/);
    expect(stored).not.toMatch(/"(type|contentType)":"application\/javascript"/);
    expect(Object.values(derived.objects as object)).toEqual(['text/html; charset=utf-8']);
    expect(objects.map((o) => o.contentType)).toEqual(['text/html; charset=utf-8']);
    const text = [stored, ...objects.map((o) => new TextDecoder().decode(o.bytes))].join('\n');
    expect(text).toContain('Transect survey');
    expect(text).not.toContain('reefScriptRan');
  });
});
