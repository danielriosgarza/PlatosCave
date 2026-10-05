import { shinyAddressProblem } from '@parallax/contracts';
import {
  createResource,
  type draftResource,
  getResource,
  updateResource,
} from '@parallax/contracts/routes/drafts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { LocalProblem, useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import { authoringKey } from './queries';
import { SaveStatus } from './SaveStatus';
import { failureMessage } from './upload';

type Full = z.output<typeof draftResource>;

const ADDRESS_HINT =
  'The address of the running app. Students see it only when the host has approved its origin; otherwise the publication check warns you.';

interface AddProps {
  courseId: string;
  topicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

/** Adds a Shiny app to a topic by its address (§10.7, §12). */
export function AddShiny({ courseId, topicId, onAdded, onCancel }: AddProps) {
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');
  const [alternative, setAlternative] = useState('');
  const problem = address.trim() ? shinyAddressProblem(address.trim()) : undefined;
  const add = useMutation({
    mutationFn: () =>
      call(createResource, {
        params: { courseId, topicId },
        body: {
          type: 'shiny',
          title: title.trim(),
          content: { url: address.trim() },
          ...(alternative.trim() && { accessibleAlternative: { text: alternative.trim() } }),
        },
      }),
    onSuccess: onAdded,
  });
  const ready = title.trim() !== '' && address.trim() !== '' && !problem;
  return (
    <form
      className={styles.feedback}
      aria-label="Add Shiny app"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) add.mutate();
      }}
    >
      <h4 className={styles.subheading}>Add Shiny app</h4>
      <label className={local.field}>
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className={local.field}>
        <label htmlFor="add-shiny-address">Address</label>
        <input
          id="add-shiny-address"
          type="text"
          inputMode="url"
          autoComplete="off"
          aria-describedby="add-shiny-address-hint"
          aria-invalid={problem ? true : undefined}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <span id="add-shiny-address-hint" className={local.hint}>
          {ADDRESS_HINT}
        </span>
        {problem ? (
          <p className={`${styles.small} ${local.failure}`} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className={local.field}>
        <label htmlFor="add-shiny-alternative">Accessible alternative</label>
        <textarea
          id="add-shiny-alternative"
          value={alternative}
          onChange={(e) => setAlternative(e.target.value)}
        />
      </div>
      <div className={`${styles.row} ${styles.mt20}`}>
        <button type="submit" className={buttons.primary} disabled={!ready || add.isPending}>
          {add.isPending ? 'Adding…' : 'Add Shiny app'}
        </button>
        <button type="button" className={buttons.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {add.isError ? (
        <p className={`${styles.small} ${local.failure} ${styles.mt12}`} role="alert">
          The Shiny app was not added. {failureMessage(add.error)}
        </p>
      ) : null}
    </form>
  );
}

interface Values {
  title: string;
  visibility: 'visible' | 'hidden';
  address: string;
  alternative: string;
  archived: boolean;
}

const addressOf = (r: Full): string => {
  const url = r.head?.content.url;
  return typeof url === 'string' ? url : '';
};

const alternativeOf = (r: Full): string => {
  const alt = r.head?.accessibleAlternative as { text?: unknown } | null | undefined;
  return typeof alt?.text === 'string' ? alt.text : '';
};

const toValues = (r: Full): Values => ({
  title: r.title,
  visibility: r.visibility,
  address: addressOf(r),
  alternative: alternativeOf(r),
  archived: r.archived,
});

/** The address, alternative and settings of one Shiny app, saved as the editor types (§12). */
export function ShinyEditor({
  courseId,
  resourceId,
  onSaved,
}: {
  courseId: string;
  resourceId: string;
  onSaved: () => void;
}) {
  const loaded = useQuery({
    queryKey: [...authoringKey(courseId), 'resource', resourceId],
    queryFn: () => call(getResource, { params: { courseId, resourceId } }),
    gcTime: 0,
  });
  if (loaded.isError) {
    return (
      <p role="alert" className={styles.small}>
        This Shiny app could not be loaded.
      </p>
    );
  }
  if (!loaded.data) return <p className={`${styles.small} ${styles.muted}`}>Loading…</p>;
  return <ShinyFields courseId={courseId} server={loaded.data} onSaved={onSaved} />;
}

function ShinyFields({
  courseId,
  server,
  onSaved,
}: {
  courseId: string;
  server: Full;
  onSaved: () => void;
}) {
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server,
    toValues,
    delayMs: 1500,
    save: (v, expectedRevision) => {
      const address = v.address.trim();
      const problem = address ? shinyAddressProblem(address) : 'A Shiny app needs an address.';
      if (problem) throw new LocalProblem(`${problem} Nothing is saved until it is valid.`);
      return call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          // Always sent: the server keeps the head when nothing changed, and after a conflict
          // the copy this form started from is stale, so no comparison here is safe.
          content: { url: address },
          accessibleAlternative: v.alternative.trim() ? { text: v.alternative.trim() } : null,
        },
      });
    },
    onSaved,
  });
  const rows = (theirs: Full) => {
    const t = toValues(theirs);
    return (
      [
        ['Title', values.title, t.title],
        ['Visibility', values.visibility, t.visibility],
        ['Address', values.address, t.address],
        ['Accessible alternative', values.alternative, t.alternative],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([label, mine, other]) => ({ label, mine, theirs: other }));
  };
  const address = values.address.trim();
  const problem = address ? shinyAddressProblem(address) : undefined;
  const id = `shiny-${server.id}`;
  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="Shiny app"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      <label className={local.field}>
        Shiny app title
        <input
          type="text"
          value={values.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      </label>
      <label className={local.field}>
        Visibility
        <select
          value={values.visibility}
          onChange={(e) => change({ visibility: e.target.value as 'visible' | 'hidden' })}
        >
          <option value="visible">Visible to students</option>
          <option value="hidden">Hidden from students</option>
        </select>
      </label>
      <div className={local.field}>
        <label htmlFor={`${id}-address`}>Address</label>
        <input
          id={`${id}-address`}
          type="text"
          inputMode="url"
          autoComplete="off"
          aria-describedby={`${id}-address-hint`}
          aria-invalid={problem ? true : undefined}
          value={values.address}
          onChange={(e) => change({ address: e.target.value })}
        />
        <span id={`${id}-address-hint`} className={local.hint}>
          {ADDRESS_HINT}
        </span>
        {problem ? (
          <p className={`${styles.small} ${local.failure}`} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className={local.field}>
        <label htmlFor={`${id}-alternative`}>Accessible alternative</label>
        <textarea
          id={`${id}-alternative`}
          value={values.alternative}
          onChange={(e) => change({ alternative: e.target.value })}
        />
      </div>
      <div className={`${styles.row} ${styles.mt16}`}>
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore this Shiny app' : 'Archive this Shiny app'}
        </button>
      </div>
    </div>
  );
}
