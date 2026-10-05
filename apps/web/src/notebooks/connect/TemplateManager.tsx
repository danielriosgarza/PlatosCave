import { type FormEvent, useId, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import {
  type ComputeTemplate,
  errorCode,
  type NewComputeTemplate,
  useComputeTemplates,
  useTemplateActions,
} from './api';
import { hostLabel, ISOLATION_TEXT } from './ClassComputers';
import styles from './Connect.module.css';
import { codeText } from './messages';

const ISOLATION_CHOICES: { value: ComputeTemplate['isolation']; label: string }[] = [
  { value: 'account', label: 'Each student has their own account on this computer' },
  { value: 'container', label: 'Each student gets their own container' },
  { value: 'allocation', label: 'An allocation service gives each student their own session' },
];

const REFUSALS: Record<string, string> = {
  recent_auth_required:
    'Changing class computers needs a recent sign-in. Sign in again, then retry.',
  class_archived: 'This class is archived.',
};

function refusalText(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: string; code?: string } } | null)?.body;
  if (body?.error === 'target_not_allowed') return codeText(body.code);
  // A missing recent sign-in is a 401 whose `code` says so.
  return REFUSALS[body?.code ?? ''] ?? REFUSALS[errorCode(error) ?? ''] ?? fallback;
}

/**
 * The instructor's class computers (design §11): the templates published for this class and a
 * form to publish another. A template holds the host, working directory pattern, runtime and
 * isolation; never an account or key, which each student supplies.
 */
export function TemplateManager({ classId }: { classId: string }) {
  const templates = useComputeTemplates(classId);
  const actions = useTemplateActions(classId);
  const [adding, setAdding] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = templates.data ?? [];

  return (
    <div className={styles.section}>
      <h3>Class computers you publish</h3>
      <p className={styles.muted}>
        Students connect to these with their own accounts and keys. You cannot see or use their
        connections.
      </p>
      {error ? (
        <div className={styles.alert} role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      {templates.isError ? (
        <div className={styles.alert} role="alert">
          <p>The class computers could not be read.</p>
        </div>
      ) : list.length > 0 ? (
        <ul className={styles.list} aria-label="Class computers">
          {list.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong>
              <span className={styles.mono}>{`${hostLabel(t)} · ${t.target.workspace}`}</span>
              {t.target.jump ? (
                <span className={styles.muted}>
                  {`Through ${t.target.jump.host}:${t.target.jump.port}`}
                </span>
              ) : null}
              <span>{ISOLATION_TEXT[t.isolation]}</span>
              <div className={styles.row}>
                {archiving === t.id ? (
                  <>
                    <span>{`Archive ${t.name}? Students can no longer connect through it.`}</span>
                    <button
                      type="button"
                      className={buttons.primary}
                      disabled={actions.archive.isPending}
                      onClick={() => {
                        setError(null);
                        actions.archive.mutate(t.id, {
                          onSuccess: () => setArchiving(null),
                          onError: (e) =>
                            setError(refusalText(e, 'The class computer could not be archived.')),
                        });
                      }}
                    >
                      Archive
                    </button>
                    <button
                      type="button"
                      className={buttons.textButton}
                      onClick={() => setArchiving(null)}
                    >
                      Keep it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={buttons.outline}
                    onClick={() => setArchiving(t.id)}
                  >
                    {`Archive ${t.name}`}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : templates.data ? (
        <p>No class computers yet.</p>
      ) : null}
      {adding ? (
        <TemplateForm
          busy={actions.create.isPending}
          onCancel={() => setAdding(false)}
          onSubmit={(body) => {
            setError(null);
            actions.create.mutate(body, {
              onSuccess: () => setAdding(false),
              onError: (e) =>
                setError(refusalText(e, 'The class computer could not be published.')),
            });
          }}
        />
      ) : (
        <div className={styles.row}>
          <button type="button" className={buttons.outline} onClick={() => setAdding(true)}>
            Publish a class computer
          </button>
        </div>
      )}
    </div>
  );
}

interface FormProps {
  busy: boolean;
  onSubmit: (body: NewComputeTemplate) => void;
  onCancel: () => void;
}

/**
 * The fields of a template. The confirmation that the host owner permits this use is required;
 * without it nothing is sent.
 */
export function TemplateForm({ busy, onSubmit, onCancel }: FormProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [useJump, setUseJump] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState('22');
  const [workspace, setWorkspace] = useState('/home/{user}/parallax');
  const [isolation, setIsolation] = useState<ComputeTemplate['isolation']>('account');
  const [python, setPython] = useState('');
  const [login, setLogin] = useState(false);
  const [kernelName, setKernelName] = useState('');
  const [setLease, setSetLease] = useState(false);
  const [idleText, setIdleText] = useState('30');
  const [graceText, setGraceText] = useState('5');
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN);
    if (!name.trim()) return setProblem('Name this class computer.');
    if (!host.trim()) return setProblem('Enter the host.');
    if (!(num(port) >= 1 && num(port) <= 65535)) return setProblem('The port is 1 to 65535.');
    if (useJump && !jumpHost.trim()) return setProblem('Enter the jump host.');
    if (useJump && !(num(jumpPort) >= 1 && num(jumpPort) <= 65535)) {
      return setProblem('The jump host port is 1 to 65535.');
    }
    if (!workspace.trim().startsWith('/')) {
      return setProblem(
        'The working directory is an absolute path, such as /home/{user}/parallax.',
      );
    }
    const idle = num(idleText);
    const grace = num(graceText);
    if (setLease && !(idle >= 5 && idle <= 240)) {
      return setProblem('Stop after: enter whole minutes from 5 to 240.');
    }
    if (setLease && !(grace >= 1 && grace <= 60)) {
      return setProblem('Keep the kernel: enter whole minutes from 1 to 60.');
    }
    if (!confirmed) {
      return setProblem('Confirm that the owner of this computer permits this class to use it.');
    }
    setProblem(null);
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      target: {
        host: host.trim(),
        port: num(port),
        workspace: workspace.trim(),
        ...(useJump && { jump: { host: jumpHost.trim(), port: num(jumpPort) } }),
      },
      runtime: {
        mode: 'start',
        ...(python.trim() && { python: python.trim() }),
        ...(login && { login: true }),
        ...(kernelName.trim() && { kernelName: kernelName.trim() }),
      },
      isolation,
      lease: setLease ? { idleTimeoutMin: idle, gracePeriodMin: grace } : null,
      hostOwnerConfirmed: true,
    });
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      noValidate
      aria-label="Publish a class computer"
    >
      {problem ? (
        <div className={styles.alert} role="alert">
          <p>{problem}</p>
        </div>
      ) : null}
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Name</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Description for students (optional)</span>
          <input
            value={description}
            maxLength={1000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Host</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Port</span>
          <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Working directory; {'{user}'} is each student's account</span>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>
      </div>
      <label className={styles.choice}>
        <input type="checkbox" checked={useJump} onChange={(e) => setUseJump(e.target.checked)} />
        Students reach this host through a jump host
      </label>
      {useJump ? (
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>Jump host</span>
            <input value={jumpHost} onChange={(e) => setJumpHost(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Jump host port</span>
            <input
              inputMode="numeric"
              value={jumpPort}
              onChange={(e) => setJumpPort(e.target.value)}
            />
          </label>
        </div>
      ) : null}
      <fieldset className={styles.fieldset}>
        <legend>How students are kept apart</legend>
        {ISOLATION_CHOICES.map((c) => (
          <label key={c.value} className={styles.choice}>
            <input
              type="radio"
              name={`${id}-isolation`}
              checked={isolation === c.value}
              onChange={() => setIsolation(c.value)}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend>Jupyter, started for each student's session</legend>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>Python interpreter (optional)</span>
            <input value={python} onChange={(e) => setPython(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Kernel name (optional)</span>
            <input value={kernelName} onChange={(e) => setKernelName(e.target.value)} />
          </label>
        </div>
        <label className={styles.choice}>
          <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} />
          Start it in a login shell
        </label>
        <label className={styles.choice}>
          <input
            type="checkbox"
            checked={setLease}
            onChange={(e) => setSetLease(e.target.checked)}
          />
          Set how long sessions are kept
        </label>
        {setLease ? (
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>Stop after minutes with no activity (5 to 240)</span>
              <input
                inputMode="numeric"
                value={idleText}
                onChange={(e) => setIdleText(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Keep the kernel after a tab closes, minutes (1 to 60)</span>
              <input
                inputMode="numeric"
                value={graceText}
                onChange={(e) => setGraceText(e.target.value)}
              />
            </label>
          </div>
        ) : null}
      </fieldset>
      <label className={styles.choice}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        The owner of this computer permits this class to use it
      </label>
      <div className={styles.row}>
        <button type="submit" className={buttons.primary} disabled={busy}>
          Publish
        </button>
        <button type="button" className={buttons.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
