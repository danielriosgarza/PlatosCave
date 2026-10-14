import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type CourseManifest, revisionPayload, topicPayload } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { revisionHash } from './canonical';
import { folderRowId } from './folder-ids';
import { planSync, type SyncOptions, type SyncState } from './folder-plan';

// The comparison of `parallax sync` (docs/design/course-folder.md §10) and the stop for a changed
// id (§4.4): each case is the drafts an earlier sync left, a folder, and the plan they give.

const [course, courseId] = ['reef-ecology', 'cdd107dd-d688-5d66-bfaf-2c8faa8f0434'];
const row = (kind: 'topic' | 'resource', id: string) => folderRowId(courseId, kind, id);
const [T1, T2] = ['5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33', '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e'];
const R1 = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const R2 = '7e6d5c4b-3a29-4f18-8e07-6d5c4b3a2918';
const R3 = '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
const [A, B, C] = ['sampling/slides/a.md', 'sampling/slides/b.md', 'counting/slides/c.md'];

type Entry = CourseManifest['topics'][number]['resources'][number];
const at = <T>(items: readonly T[], i: number): T => items[i] ?? expect.unreachable(`no ${i}`);
const deck = (id: string, path: string, markdown = `# ${path}`): Entry => {
  const fields = { id, title: path, visibility: 'visible', overlay: false, path } as const;
  return { ...fields, type: 'slides_web', source: { markdown } };
};
/** a.md and b.md in the first topic, c.md in the second. */
const folder = (): CourseManifest => ({
  ...{ title: 'Reef ecology', public: true, files: [] },
  topics: [
    { id: T1, position: 0, title: 'Sampling', resources: [deck(R1, A), deck(R2, B)] },
    { id: T2, position: 1, title: 'Counting', resources: [deck(R3, C)] },
  ],
});
const entries = (m: CourseManifest, topic: number) => at(m.topics, topic).resources;
/** The folder with c.md changed. */
const changed = () => {
  const m = folder();
  entries(m, 1)[0] = deck(R3, C, '# C, revised');
  return m;
};
const payloads = (m: CourseManifest) =>
  new Map(
    m.topics.flatMap((t) =>
      t.resources.map((r) => [r.id, revisionPayload(r, (file) => ({ key: `k/${file}` }))] as const),
    ),
  );

/** The drafts a sync of `m` leaves: derived ids, and each head stored from the folder. */
function synced(m: CourseManifest): SyncState {
  const stored = payloads(m);
  const resources = m.topics.flatMap((t) =>
    t.resources.map(({ id, title, path, overlay, visibility }, position) => {
      const { type, ...head } = stored.get(id) ?? expect.unreachable();
      const digest = revisionHash(type, { ...head, provenance: null });
      const provenance = { source: 'folder', course, topic: t.id, resource: id, path, overlay };
      const fields = { id: row('resource', id), topicId: row('topic', t.id), position, visibility };
      const state = { type, title, revision: 1, archived: false };
      return { ...fields, ...state, head: { ...head, provenance: { ...provenance, digest } } };
    }),
  );
  const topics = m.topics.map((t) => ({ ...topicPayload(t, row), id: row('topic', t.id) }));
  const live = { revision: 1, archived: false };
  return { courseId, folder: course, topics: topics.map((t) => ({ ...t, ...live })), resources };
}
const plan = (state: SyncState, m: CourseManifest, options: Partial<SyncOptions> = {}) =>
  planSync(state, m, payloads(m), { overwriteEditor: false, acceptNewIds: false, ...options });
const update = (kind: 'topic' | 'resource', id: string, input: object) => {
  const op = kind === 'topic' ? 'updateTopic' : 'updateResource';
  return { op, id: row(kind, id), input: { expectedRevision: 1, ...input } };
};
/** The step that makes c.md of `m` the head of its resource. */
const revised = (m: CourseManifest) =>
  update('resource', R3, at(synced(m).resources, 2).head ?? {});
const archived = { archived: true };
const nothing = { steps: [], refusals: [], replaced: [], editorOnly: 0 };
/** `state` after the editor saved c.md's resource with `markdown`; provenance is carried. */
function edited(state: SyncState, markdown: string): SyncState {
  const c = at(state.resources, 2);
  c.head = { ...(c.head ?? expect.unreachable()), content: { markdown } };
  return state;
}

describe('planSync', () => {
  test('an unchanged folder gives an empty plan', () => {
    expect(plan(synced(folder()), folder())).toEqual(nothing);
  });

  test('a changed file gives one new revision of the same resource', () => {
    expect(plan(synced(folder()), changed())).toEqual({ ...nothing, steps: [revised(changed())] });
  });

  test('a file renamed and moved to another topic with the same bytes gets no revision, only its topic and position', () => {
    const m = folder();
    const a = at(entries(m, 0).splice(0, 1), 0);
    entries(m, 1).push({ ...a, path: 'counting/slides/moved.md' });
    expect(plan(synced(folder()), m).steps).toEqual([
      update('resource', R2, { position: 0 }),
      update('resource', R1, { topicId: row('topic', T2), position: 1 }),
    ]);
  });

  test('a new order gives only positions', () => {
    const m = folder();
    const [sampling, counting] = [at(m.topics, 0), at(m.topics, 1)];
    [sampling.position, counting.position] = [1, 0];
    m.topics = [counting, sampling];
    sampling.resources.reverse();
    expect(plan(synced(folder()), m).steps).toEqual([
      update('topic', T2, { position: 0 }),
      update('topic', T1, { position: 1 }),
      update('resource', R2, { position: 0 }),
      update('resource', R1, { position: 1 }),
    ]);
  });

  test('a removed entry and a removed topic are archived, and restored when listed again', () => {
    const m = folder();
    entries(m, 0).pop();
    m.topics.pop();
    expect(plan(synced(folder()), m)).toEqual({
      ...nothing,
      steps: [
        update('resource', R2, archived),
        update('resource', R3, archived),
        update('topic', T2, archived),
      ],
    });
    const state = synced(folder());
    for (const r of [...state.topics, ...state.resources]) r.archived = true;
    const restored = plan(state, folder()).steps.map(({ input }) => input);
    expect(restored).toEqual(Array(5).fill({ expectedRevision: 1, archived: false }));
  });

  test('a topic and a resource with random ids are left as they are', () => {
    const state = synced(folder());
    state.topics.push({ ...at(state.topics, 1), id: randomUUID(), title: 'Made in the editor' });
    state.resources.push({ ...at(state.resources, 2), id: randomUUID(), title: 'Notes' });
    expect(plan(state, folder())).toEqual({ ...nothing, editorOnly: 2 });
  });

  test("an editor's save on a sync-made resource is refused, and with overwriteEditor it becomes a new revision", () => {
    const state = edited(synced(folder()), '# C, edited');
    const message =
      'its head revision was saved in the editor; sync with --overwrite-editor to replace it';
    expect(plan(state, changed())).toEqual({ ...nothing, refusals: [{ path: C, message }] });
    const overwritten = plan(state, changed(), { overwriteEditor: true });
    expect(overwritten).toEqual({ ...nothing, steps: [revised(changed())] });
  });

  test("archiving an editor's head, or a topic that holds a resource made in the editor, is refused", () => {
    const state = edited(synced(folder()), '# C, edited');
    state.resources.push({ ...at(state.resources, 2), id: randomUUID(), title: 'Notes' });
    const m = folder();
    m.topics.pop();
    expect(plan(state, m).refusals).toEqual([
      { path: C, message: expect.stringContaining('saved in the editor') },
      { message: expect.stringMatching(/^the topic "Counting" .* "Notes"/) },
    ]);
    const steps = [update('resource', R3, archived), update('topic', T2, archived)];
    expect(plan(state, m, { overwriteEditor: true })).toEqual({ ...nothing, steps, editorOnly: 1 });
  });

  test("a save that puts the folder's content back, and an editor's head equal to the folder, are no refusal", () => {
    // The editor saved another text, then the folder's again.
    const back = edited(edited(synced(folder()), '# C, edited'), `# ${C}`);
    expect(plan(back, changed())).toEqual({ ...nothing, steps: [revised(changed())] });
    // The editor's head already holds what the folder now holds: a revision records the folder.
    const equal = edited(synced(folder()), '# C, revised');
    expect(plan(equal, changed())).toEqual({ ...nothing, steps: [revised(changed())] });
  });

  test.each([
    ['written again by check --write-ids', randomUUID()],
    ['edited by hand', R3.replace(/d$/, 'e')],
  ])('an id %s at the path the earlier resource recorded is refused', (_, id) => {
    const m = folder();
    entries(m, 1)[0] = { ...deck(R3, C), id };
    const refused = plan(synced(folder()), m);
    expect(refused.refusals).toEqual([{ path: C, message: expect.stringContaining(id) }]);
    expect(at(refused.refusals, 0).message).toContain(R3);
    // With acceptNewIds: a creation, and an archive reported with the earlier id.
    const accepted = plan(synced(folder()), m, { acceptNewIds: true });
    expect(accepted).toMatchObject({ refusals: [], replaced: [{ path: C, earlier: R3, id }] });
    expect(accepted.steps.map((step) => [step.op, step.id, step.input])).toEqual([
      ['createResource', row('resource', id), expect.objectContaining({ title: C })],
      ['updateResource', row('resource', R3), { expectedRevision: 1, archived: true }],
    ]);
  });

  test('a new id at another path is a creation', () => {
    const [m, id, path] = [folder(), randomUUID(), 'counting/slides/d.md'];
    entries(m, 1)[0] = deck(id, path);
    const { head } = at(synced(m).resources, 2);
    const input = { type: 'slides_web', title: path, position: 0, visibility: 'visible', ...head };
    const create = { op: 'createResource', id: row('resource', id), topicId: row('topic', T2) };
    const steps = [{ ...create, input }, update('resource', R3, archived)];
    expect(plan(synced(folder()), m)).toEqual({ ...nothing, steps });
  });

  test('a different kind of file under an old id is refused', () => {
    const [m, path] = [folder(), 'counting/reading/c.md'];
    entries(m, 1)[0] = { ...deck(R3, C), type: 'reading_native', path, source: { file: path } };
    const refusals = [{ path, message: expect.stringContaining('give the entry a new id') }];
    expect(plan(synced(folder()), m)).toEqual({ ...nothing, refusals });
  });

  test('prerequisites and completion requirements come out as row ids', () => {
    const m = folder();
    const requires = ['reviewed:*', `submitted:${R3}`];
    Object.assign(at(m.topics, 1), { prerequisites: [T1], completionRule: { requires } });
    const fields = {
      prerequisites: [row('topic', T1)],
      completionRule: { requires: ['reviewed:*', `submitted:${row('resource', R3)}`] },
    };
    expect(plan(synced(folder()), m).steps).toEqual([update('topic', T2, fields)]);
    const first = plan({ ...synced(folder()), topics: [], resources: [] }, m).steps;
    const input = { position: 1, title: 'Counting', objective: '', estimatedMinutes: null };
    expect(at(first, 1)).toEqual({
      op: 'createTopic',
      id: row('topic', T2),
      input: { ...input, ...fields },
    });
  });

  test('a deck the upload rules refuse, and text that cannot be stored, are refused', () => {
    const [m, quiz] = [folder(), 'counting/tests/quiz.yaml'];
    entries(m, 0)[0] = deck(R1, A, '');
    entries(m, 0)[1] = deck(R2, B, '# B\0');
    entries(m, 1)[0] = deck(R3, C, '# C \uD800');
    const code = { files: [{ path: 'main.py', content: 'print(1)\0' }] };
    const test = { type: 'test', source: { definition: { questions: [code] } } };
    entries(m, 1).push({ ...deck(randomUUID(), quiz), ...test } as unknown as Entry);
    at(m.topics, 0).title = 'Sampling\0';
    expect(plan(synced(folder()), m).refusals).toEqual([
      { message: expect.stringMatching(new RegExp(`^topic ${T1}: .*NUL`)) },
      { path: A, message: 'The file is empty' },
      { path: B, message: 'The file is not text' },
      { path: C, message: 'The text is not valid UTF-8' },
      { path: quiz, message: expect.stringContaining('NUL') },
    ]);
  });

  test('the ids and the plan reach no database module through their imports', () => {
    const seen = new Set<string>();
    const follow = (file: string): string[] => {
      if (seen.has(file)) return [];
      seen.add(file);
      const code = readFileSync(file, 'utf8');
      const specs = [...code.matchAll(/from '([^']+)'/g)].map(([, spec]) => spec ?? '');
      const local = specs.filter((spec) => spec.startsWith('.'));
      return [...specs, ...local.flatMap((spec) => follow(resolve(dirname(file), `${spec}.ts`)))];
    };
    const specs = ['folder-ids.ts', 'folder-plan.ts'].flatMap((name) =>
      follow(resolve(import.meta.dirname, name)),
    );
    expect(specs).toContain('./canonical');
    expect(specs.filter((spec) => /(^|\/)(db|auth)\/|drizzle|^pg$/.test(spec))).toEqual([]);
  });
});
