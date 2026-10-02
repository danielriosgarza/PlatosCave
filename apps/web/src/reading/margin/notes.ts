import type { Anchor } from '@parallax/contracts';
import type { annotationView } from '@parallax/contracts/routes/annotations';
import type { z } from 'zod';

export type Annotation = z.output<typeof annotationView>;

/** Autosave waits this long after the last keystroke (§8: about one second of inactivity). */
export const AUTOSAVE_MS = 1000;

/**
 * What the editor beside the text shows. `saved` is only ever set from a server acknowledgement;
 * `offline` and `failed` keep the text on this device and say so.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'failed' | 'conflict';

export interface NoteState {
  body: string;
  status: SaveStatus;
  /** The server's copy when a save found it changed elsewhere (conflict recovery view). */
  conflict: Annotation | null;
  /** True once the server holds this note. */
  created: boolean;
  /** Why the last save failed, in words for the person (e.g. the class is archived). */
  reason: string | null;
}

export type SendResult =
  | { kind: 'ok'; annotation: Annotation }
  | { kind: 'conflict'; current: Annotation }
  | { kind: 'offline' }
  | { kind: 'failed'; reason: string | null };

export interface NoteDeps {
  create(anchor: Anchor, body: string): Promise<SendResult>;
  save(id: string, expectedRevision: number, body: string): Promise<SendResult>;
  /** Keeps (or with null, drops) the unsent text on this device; resolves when it is written. */
  persist(
    draft: { annotationId: string | null; revision: number | null; body: string } | null,
  ): void;
  /** Tells the page what the server now holds, after an acknowledgement or a chosen server copy. */
  acknowledged(annotation: Annotation): void;
}

export interface NoteInit {
  /** Stable for the controller's life: the draft's key and the entry's id until the note exists. */
  key: string;
  anchor: Anchor;
  body: string;
  annotationId: string | null;
  revision: number | null;
  /** Restored from this device: the text has not reached the server yet. */
  unsent?: boolean;
}

/**
 * One note's text and its saving, kept outside the editor so a margin or tab change neither drops
 * a pending save nor loses the draft (§8). Edits are saved after a second of inactivity and on
 * blur, one request at a time; the text typed meanwhile follows in the next request. A stale
 * revision never overwrites: the person chooses between their text and the server's.
 */
export class NoteController {
  state: NoteState;
  readonly anchor: Anchor;
  readonly key: string;
  annotationId: string | null;
  private revision: number | null;
  private serverBody: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly online = () => {
    if (this.state.status === 'offline') void this.flush();
  };

  constructor(
    init: NoteInit,
    private readonly deps: NoteDeps,
  ) {
    this.anchor = init.anchor;
    this.key = init.key;
    this.annotationId = init.annotationId;
    this.revision = init.revision;
    this.serverBody = init.unsent ? null : init.body;
    this.state = {
      body: init.body,
      status: init.unsent ? 'saving' : 'idle',
      conflict: null,
      created: init.annotationId !== null,
      reason: null,
    };
    window.addEventListener('online', this.online);
    if (init.unsent) void this.flush();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<NoteState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  edit(body: string) {
    if (body === this.state.body) return;
    this.set({ body, status: 'saving', reason: null });
    this.deps.persist({ annotationId: this.annotationId, revision: this.revision, body });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  /** The editor lost focus: save now instead of waiting out the pause. */
  blur() {
    if (this.timer) void this.flush();
  }

  retry() {
    void this.flush();
  }

  /** Stops timers and listeners; a save still pending is sent first. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('online', this.online);
    if (this.timer) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sending || this.state.status === 'conflict') return;
    const body = this.state.body;
    if (this.annotationId === null && body.trim() === '') {
      // Nothing was ever written: there is no note to create.
      this.deps.persist(null);
      this.set({ status: 'idle' });
      return;
    }
    if (this.annotationId !== null && body === this.serverBody) {
      this.deps.persist(null);
      this.set({ status: 'saved' });
      return;
    }
    this.sending = true;
    this.set({ status: 'saving', reason: null });
    let result: SendResult;
    try {
      result =
        this.annotationId === null
          ? await this.deps.create(this.anchor, body)
          : await this.deps.save(this.annotationId, this.revision ?? 1, body);
    } catch {
      result = { kind: 'failed', reason: null };
    }
    this.sending = false;
    if (result.kind === 'ok') {
      this.annotationId = result.annotation.id;
      this.revision = result.annotation.revision;
      this.serverBody = result.annotation.body ?? '';
      this.deps.acknowledged(result.annotation);
      this.set({ created: true, conflict: null });
      if (this.state.body !== body) {
        // More was typed while this request ran: it goes in the next one.
        this.deps.persist({
          annotationId: this.annotationId,
          revision: this.revision,
          body: this.state.body,
        });
        if (this.timer === null) this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
        this.set({ status: 'saving' });
        return;
      }
      this.deps.persist(null);
      this.set({ status: 'saved' });
    } else if (result.kind === 'conflict') {
      this.set({ status: 'conflict', conflict: result.current });
    } else if (result.kind === 'offline') {
      this.deps.persist({
        annotationId: this.annotationId,
        revision: this.revision,
        body: this.state.body,
      });
      this.set({ status: 'offline' });
    } else {
      this.deps.persist({
        annotationId: this.annotationId,
        revision: this.revision,
        body: this.state.body,
      });
      this.set({ status: 'failed', reason: result.reason });
    }
  }

  /** Conflict recovery: the person's text goes over the server's, by their choice. */
  keepMine() {
    const current = this.state.conflict;
    if (!current) return;
    this.revision = current.revision;
    this.serverBody = current.body ?? '';
    this.set({ conflict: null, status: 'saving' });
    void this.flush();
  }

  /** Conflict recovery: the server's text replaces this device's draft. */
  takeSaved() {
    const current = this.state.conflict;
    if (!current) return;
    this.revision = current.revision;
    this.serverBody = current.body ?? '';
    this.deps.persist(null);
    this.deps.acknowledged(current);
    this.set({ conflict: null, body: current.body ?? '', status: 'saved' });
  }
}
