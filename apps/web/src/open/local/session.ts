import {
  type ConnectorClient,
  ConnectorError,
  client,
  hello,
  type OpenedSession,
  pair,
  pairingCode,
  type StartedKernel,
} from './connector';

/**
 * The notebooks this page runs on this computer (docs/design/open-site.md §14), kept in memory
 * for the page load only: the key the connector gave this page and, by notebook, its session and
 * kernel, so leaving a notebook and coming back finds its kernel as it was. Closing or leaving the
 * page stops them; the connector also stops a session no page has used for 30 minutes.
 */

export interface LocalRun {
  client: ConnectorClient;
  opened: OpenedSession;
  kernel: StartedKernel;
}

export type ConnectPhase =
  | { phase: 'looking' }
  | { phase: 'asking'; code: string }
  | { phase: 'starting' }
  | { phase: 'kernel' };

let key: string | null = null;
const runs = new Map<string, LocalRun>();

export const runOf = (notebook: string): LocalRun | undefined => runs.get(notebook);

/**
 * The kernel to start: the notebook's own (by its name or the name it shows, `Python 3`) if this
 * computer has it, else one of its language, else the first.
 */
export function chooseKernel(
  specs: OpenedSession['kernelspecs'],
  wanted: { kernel: string | null; language: string | null },
): string | null {
  const list = specs ?? [];
  const byName = list.find(
    (s) => wanted.kernel !== null && (s.name === wanted.kernel || s.displayName === wanted.kernel),
  );
  if (byName) return byName.name;
  const lang = wanted.language?.toLowerCase();
  const byLanguage = list.find((s) => lang !== undefined && s.language.toLowerCase() === lang);
  return (byLanguage ?? list[0])?.name ?? null;
}

/**
 * Connects the notebook named `notebook` (its data file's address): finds the connector, has the
 * visitor allow this site in its terminal once per page load, starts Jupyter in the notebook's
 * folder with its files, then a kernel. `onPhase` tells the page what it waits for.
 */
export async function connect(args: {
  notebook: string;
  folder: string[];
  files: string | null;
  kernel: string | null;
  language: string | null;
  onPhase: (phase: ConnectPhase) => void;
}): Promise<LocalRun> {
  const existing = runs.get(args.notebook);
  if (existing) return existing;
  args.onPhase({ phase: 'looking' });
  if (!(await hello())) throw new ConnectorError('unreachable', 0);
  const files = args.files === null ? null : new URL(args.files, window.location.href).href;
  let opened: OpenedSession | undefined;
  for (let attempt = 0; opened === undefined; attempt++) {
    if (key === null) {
      const code = pairingCode();
      args.onPhase({ phase: 'asking', code });
      key = await pair(code);
    }
    args.onPhase({ phase: 'starting' });
    try {
      opened = await client(key).open(args.folder, files);
    } catch (error) {
      // A connector started again since this page connected does not know its key: ask again.
      if (error instanceof ConnectorError && error.code === 'not_paired' && attempt === 0) {
        key = null;
        continue;
      }
      throw error;
    }
  }
  const pageClient = client(key as string);
  const name = chooseKernel(opened.kernelspecs, args);
  if (name === null) {
    await pageClient.stop(opened.session).catch(() => {});
    throw new ConnectorError('no_kernelspec', 0);
  }
  args.onPhase({ phase: 'kernel' });
  let kernel: StartedKernel;
  try {
    kernel = await pageClient.startKernel(opened.session, name);
  } catch (error) {
    await pageClient.stop(opened.session).catch(() => {});
    throw error;
  }
  const run = { client: pageClient, opened, kernel };
  runs.set(args.notebook, run);
  return run;
}

/** Stops one notebook's session: its Jupyter server and kernel end on this computer. */
export async function stop(notebook: string): Promise<void> {
  const run = runs.get(notebook);
  if (!run) return;
  runs.delete(notebook);
  await run.client.stop(run.opened.session);
}

/** Forgets a session the connector no longer has (it stopped, or stopped it). */
export const forget = (notebook: string) => runs.delete(notebook);

/** Stops every session as the page goes away; requests that outlive the page. */
export function stopAll(): void {
  for (const [notebook, run] of runs) {
    runs.delete(notebook);
    run.client.stop(run.opened.session, true).catch(() => {});
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', stopAll);

/** For tests: forget the key and every session without a request. */
export function resetLocalRuns(): void {
  key = null;
  runs.clear();
}
