import { LinkServerMessage } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import {
  channelMessage,
  contentPath,
  contents,
  deleteKernel,
  httpMessage,
  interruptKernel,
  JupyterArgumentError,
  type JupyterRequest,
  kernelState,
  kernelspecs,
  listKernels,
  restartKernel,
  startKernel,
  status,
} from './jupyter';

/**
 * An independent reading of the allowlist of docs/design/connector.md §7, the table the
 * connector enforces: every request the relay builds must pass it, whatever the arguments.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sessionRules: [string, RegExp][] = [
  ['GET', /^\/api\/(status|kernelspecs|kernels)$/],
  ['GET', new RegExp(`^/api/kernels/${UUID}$`)],
  ['POST', /^\/api\/kernels$/],
  ['DELETE', new RegExp(`^/api/kernels/${UUID}$`)],
  ['POST', new RegExp(`^/api/kernels/${UUID}/(interrupt|restart)$`)],
];
const QUERY_KEYS = new Set(['content', 'type', 'format', 'hash']);

function allowedByConnector(request: JupyterRequest, contentRoot: string): boolean {
  const [path = '', search] = request.path.split('?');
  if (request.purpose === 'session') {
    return (
      search === undefined && sessionRules.some(([m, re]) => m === request.method && re.test(path))
    );
  }
  if (!['GET', 'PUT', 'POST', 'DELETE'].includes(request.method)) return false;
  if (!path.startsWith('/api/contents')) return false;
  const decoded = decodeURIComponent(path.slice('/api/contents'.length).replace(/^\//, ''));
  if (decodeURIComponent(decoded) !== decoded || decoded.length > 1024) return false;
  if (decoded.includes('\u0000') || decoded.includes('\\') || decoded.includes('//')) return false;
  const parts = decoded === '' ? [] : decoded.split('/');
  if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) return false;
  const root = contentRoot === '' ? [] : contentRoot.split('/');
  if (!root.every((seg, i) => parts[i] === seg)) return false;
  if (search !== undefined) {
    for (const pair of search.split('&')) {
      const [key = '', value = ''] = pair.split('=');
      if (!QUERY_KEYS.has(key) || !/^[A-Za-z0-9]+$/.test(value)) return false;
    }
  }
  if (request.method === 'POST' && request.body) {
    const keys = Object.keys(JSON.parse(request.body.toString('utf8')) as object);
    if (!keys.every((k) => k === 'type' || k === 'ext')) return false;
  }
  return true;
}

const kernel = '9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f';
const sessionId = '7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

/** Arguments a caller (or an attacker steering one) might pass. */
const hostile = [
  '../etc/passwd',
  'parallax/../../etc',
  '..',
  '.',
  '.ssh/id_ed25519',
  'parallax/.git/config',
  'parallax//a.csv',
  '/etc/passwd',
  'parallax\\..\\secret',
  'a\u0000b',
  'parallax/%2e%2e/secret',
  'parallax/%252e%252e',
  'x'.repeat(1100),
];
/** Arguments that are odd file names, not escapes: allowed only as encoded names under the root. */
const odd = ['parallax-private/a.csv', 'parallax/a.csv?token=abc', 'parallax/a.csv#x'];

describe('typed Jupyter operations', () => {
  test('session operations build exactly the allowlisted calls', () => {
    const built = [
      status(),
      kernelspecs(),
      listKernels(),
      startKernel('python3'),
      startKernel('ir'),
      kernelState(kernel),
      deleteKernel(kernel),
      interruptKernel(kernel),
      restartKernel(kernel),
    ];
    for (const request of built) {
      expect(allowedByConnector(request, ''), `${request.method} ${request.path}`).toBe(true);
    }
    expect(JSON.parse(startKernel('python3').body?.toString() ?? '')).toEqual({ name: 'python3' });
  });

  test('a kernel id or kernel name that is not one is refused', () => {
    const ids = ['../status', 'ABC', `${kernel}/channels`, `${kernel}?x=1`, ''];
    for (const id of ids) {
      for (const op of [kernelState, deleteKernel, interruptKernel, restartKernel]) {
        expect(() => op(id), id).toThrow(JupyterArgumentError);
      }
    }
    for (const name of ['-x', 'a b', '../k', 'x'.repeat(65), '']) {
      expect(() => startKernel(name), name).toThrow(JupyterArgumentError);
    }
  });

  test('the kernel channel carries the notebook session id', () => {
    const message = channelMessage(kernel, 3, sessionId);
    expect(message.path).toBe(`/api/kernels/${kernel}/channels?session_id=${sessionId}`);
    expect(LinkServerMessage.safeParse(message).success).toBe(true);
    expect(() => channelMessage(kernel, 3, 'not-a-session')).toThrow(JupyterArgumentError);
  });

  test('no operation can produce a path outside the allowlist', () => {
    for (const root of ['', 'parallax', 'courses/stats']) {
      const builders: ((p: string) => JupyterRequest)[] = [
        (p) => contents.list(root, p),
        (p) => contents.get(root, p, { content: 1, format: 'text', hash: 1 }),
        (p) => contents.put(root, p, { type: 'file', format: 'text', content: 'x' }),
        (p) => contents.create(root, p, { type: 'file', ext: '.py' }),
        (p) => contents.delete(root, p),
      ];
      const good = root === '' ? ['a.csv', 'data/b.csv'] : [`${root}/a.csv`, `${root}/x y/ü.csv`];
      for (const build of builders) {
        for (const p of [...hostile, ...odd, ...good]) {
          let request: JupyterRequest | undefined;
          try {
            request = build(p);
          } catch (err) {
            expect(err).toBeInstanceOf(JupyterArgumentError);
            continue;
          }
          expect(allowedByConnector(request, root), `${root} ${p} → ${request.path}`).toBe(true);
          expect(hostile, `${p} was built`).not.toContain(p);
        }
        for (const p of good) expect(() => build(p)).not.toThrow();
      }
    }
  });

  test('the segment rule keeps a sibling of the content root out', () => {
    expect(() => contentPath('parallax', 'parallax-private/a.csv')).toThrow(JupyterArgumentError);
    expect(contentPath('parallax', 'parallax/a b.csv')).toBe('parallax/a%20b.csv');
    expect(() => contents.delete('parallax', 'parallax')).toThrow(JupyterArgumentError);
  });

  test('a create body holds only type and ext', () => {
    const request = contents.create('', '', { type: 'file', ext: '.ipynb' });
    expect(JSON.parse(request.body?.toString() ?? '')).toEqual({ type: 'file', ext: '.ipynb' });
    expect(() => contents.create('', '', { type: 'file', ext: '../x' })).toThrow(
      JupyterArgumentError,
    );
  });

  test('the link message is valid protocol and streams a body with its length', () => {
    const put = contents.put('', 'a.csv', { type: 'file', format: 'text', content: 'x,y\n' });
    const message = httpMessage(put, 7, sessionId);
    expect(LinkServerMessage.safeParse(message).success).toBe(true);
    expect(message).toMatchObject({
      body: 'stream',
      contentLength: put.body?.length,
      purpose: 'contents',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    const get = httpMessage(status(), 8, sessionId);
    expect(LinkServerMessage.safeParse(get).success).toBe(true);
    expect(get.body).toBe('none');
  });
});
