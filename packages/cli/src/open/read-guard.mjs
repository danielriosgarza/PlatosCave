// The file-read guard of the level 0 tests (docs/design/open-site.md §10, check 1): test support,
// not packed. `testing.ts` preloads it into a child process with `--import`, and worker threads
// inherit it, so it is plain JavaScript. With PARALLAX_READ_GUARD `{ log, site, courses }` it
// refuses, and records in `log` as a line of JSON, every call of `node:fs` and `node:fs/promises`
// that opens the content of a file (an open, a read, a read stream, a blob, a copy) below
// `<site>/private/` or below the `exercises/` or `tests/` folder of a topic of one of `courses`. A
// read through a descriptor or a file handle is stopped at the open that gives it; listings pass.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const given = process.env.PARALLAX_READ_GUARD;
const { log, site, courses = [] } = given ? JSON.parse(given) : {};
/** A path with its links resolved; where it does not exist, its nearest folder's. */
const realOf = (path) =>
  fs.existsSync(path) || dirname(path) === path
    ? fs.realpathSync.native(path)
    : join(realOf(dirname(path)), basename(path));
/**
 * A path argument as `node:fs` takes it, from the working folder: a string is a path (never a
 * URL), a `file:` URL its path, bytes UTF-8; a descriptor or a file handle names none. Each path
 * and each place is compared as given and with its links resolved, in lower case.
 */
const pathOf = (target) => {
  const url = target?.protocol === 'file:' && typeof target.href === 'string';
  if (url || typeof target === 'string') return resolve(url ? fileURLToPath(target.href) : target);
  return target instanceof Uint8Array ? resolve(Buffer.from(target).toString()) : undefined;
};
const forms = (path) => [path, realOf(path)].map((form) => form.toLowerCase());
/** The names of a path below a folder, the folder itself included, or undefined. */
const below = (folder, path) => {
  const from = relative(folder, path);
  const out = from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from);
  return out ? undefined : from.split(sep).filter(Boolean);
};
const privates = given ? forms(join(site, 'private')) : [];
const trees = courses.flatMap(forms);
const folder = (path) => fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
/** Whether a path lies in a guarded place or, for a copy of a folder, holds one. */
const guarded = (path, copy) =>
  forms(path).some((form) => {
    // A copy of a topic's folder, of a course's or of one above a place copies what is below.
    const holds = (at, names) => copy && folder(path) && (names?.length === 1 || below(form, at));
    const tree = (at, names = below(at, form)) =>
      /^(exercises|tests)$/.test(names?.[1] ?? '') || holds(at, names);
    return privates.some((at) => below(at, form) || holds(at)) || trees.some((at) => tree(at));
  });

/** Wraps a call: a guarded path is recorded and refused, as the call reports an error. */
function wrap(module, name, kind) {
  const call = module[name];
  module[name] = function guardedCall(target, ...rest) {
    const path = pathOf(target);
    const pass = path === undefined || !guarded(path, name.startsWith('cp'));
    if (pass) return call.call(this, target, ...rest);
    fs.appendFileSync(log, `${JSON.stringify({ call: name, path, real: realOf(path) })}\n`);
    const error = Object.assign(new Error(`read-guard: ${name} ${path}`), { code: 'EACCES' });
    if (kind === 'promise') return Promise.reject(error);
    const done = rest.at(-1);
    if (kind === 'sync' || typeof done !== 'function') throw error;
    process.nextTick(done, error);
  };
}

if (given) {
  for (const name of ['open', 'readFile', 'copyFile', 'cp']) wrap(fs, name, 'callback');
  for (const name of ['open', 'readFile', 'copyFile', 'cp']) wrap(fs.promises, name, 'promise');
  for (const name of ['openSync', 'readFileSync', 'copyFileSync', 'cpSync', 'createReadStream'])
    wrap(fs, name, 'sync');
  wrap(fs, 'openAsBlob', 'promise');
  syncBuiltinESMExports();
}
