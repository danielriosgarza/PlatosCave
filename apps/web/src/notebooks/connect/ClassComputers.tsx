import { targetFromTemplate, USER_PLACEHOLDER } from '@parallax/contracts/routes/computeTemplates';
import { type FormEvent, useId, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { ComputeTemplate, Connection, Connector } from './api';
import styles from './Connect.module.css';
import type { TargetValues } from './TargetForm';

/** How the template's host keeps students apart (spec §10.3), in plain words. */
export const ISOLATION_TEXT: Record<ComputeTemplate['isolation'], string> = {
  account:
    'Each student signs in with their own account on this computer, so classmates cannot open each other’s files or sessions.',
  container:
    'Each student gets their own container on this computer, so classmates cannot open each other’s files or sessions.',
  allocation:
    'Each student gets their own session from this computer’s allocation service, so classmates cannot open each other’s files or sessions.',
};

/** The statement of design §5.6 for a connection made with the person's own account. */
export const PERSONAL_STATEMENT =
  'You connect with your own account and your own key. This connection can read and change the files your account can, with its privileges.';

export const hostLabel = (t: ComputeTemplate) =>
  `${t.target.host}${t.target.port === 22 ? '' : `:${t.target.port}`}`;

interface Props {
  templates: ComputeTemplate[];
  /** Active connectors only. */
  connectors: Connector[];
  /** A saved connection made from one of `templates`; its values fill the form. */
  saved?: Connection;
  busy: boolean;
  onSubmit: (values: TargetValues & { templateId: string }) => void;
}

/**
 * Class computers (design §11): the learner picks a template their instructor published and
 * supplies only their own account and credential reference. The template's host, jump host and
 * working directory are fixed; there is no field for a password, passphrase or token.
 */
export function TemplateConnectForm({ templates, connectors, saved, busy, onSubmit }: Props) {
  const id = useId();
  const sshSaved = saved?.target.kind === 'ssh' ? saved.target : undefined;
  const [templateId, setTemplateId] = useState(saved?.templateId ?? templates[0]?.id ?? '');
  const template = templates.find((t) => t.id === templateId);
  const [name, setName] = useState(saved?.name ?? template?.name.slice(0, 60) ?? '');
  const [connectorId, setConnectorId] = useState(saved?.connectorId ?? connectors[0]?.id ?? '');
  const [user, setUser] = useState(sshSaved?.user ?? '');
  const [jumpUser, setJumpUser] = useState(
    sshSaved?.jump && sshSaved.jump.user !== sshSaved.user ? sshSaved.jump.user : '',
  );
  const [method, setMethod] = useState<'key' | 'agent'>(
    sshSaved?.auth.method === 'agent' ? 'agent' : 'key',
  );
  const [keyPath, setKeyPath] = useState(
    sshSaved?.auth.method === 'key' ? sshSaved.auth.keyPath : '',
  );
  const [hint, setHint] = useState(
    sshSaved?.auth.method === 'agent' ? (sshSaved.auth.hint ?? '') : '',
  );
  const [problem, setProblem] = useState<string | null>(null);

  const account = user.trim();
  const workspace = template
    ? template.target.workspace.split(USER_PLACEHOLDER).join(account || 'your-account')
    : '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!template) return setProblem('Choose a class computer.');
    if (!name.trim()) return setProblem('Name this connection.');
    if (!connectorId) return setProblem('Choose the computer that runs the connector.');
    if (!account) return setProblem('Enter your account on this computer.');
    if (method === 'key' && !keyPath.trim()) return setProblem('Enter the path of your key file.');
    if (method === 'agent' && !hint.trim()) {
      return setProblem('Enter the comment or fingerprint of the agent key to use.');
    }
    setProblem(null);
    const target = targetFromTemplate(template.target, {
      user: account,
      auth:
        method === 'key'
          ? { method: 'key', keyPath: keyPath.trim() }
          : { method: 'agent', hint: hint.trim() },
      ...(template.target.jump && jumpUser.trim() && { jumpUser: jumpUser.trim() }),
    });
    onSubmit({
      name: name.trim(),
      connectorId,
      target,
      runtime: saved?.runtime ?? template.runtime,
      templateId: template.id,
    });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {problem ? (
        <div className={styles.alert} role="alert">
          <p>{problem}</p>
        </div>
      ) : null}
      {saved ? null : (
        <fieldset className={styles.fieldset}>
          <legend>Class computer</legend>
          {templates.map((t) => (
            <label key={t.id} className={styles.choice}>
              <input
                type="radio"
                name={`${id}-template`}
                checked={t.id === templateId}
                onChange={() => {
                  setTemplateId(t.id);
                  setName(t.name.slice(0, 60));
                }}
              />
              {`${t.name} · ${hostLabel(t)}`}
            </label>
          ))}
        </fieldset>
      )}
      {template ? (
        <div className={styles.notice} role="note">
          {template.description ? <p>{template.description}</p> : null}
          <p>{ISOLATION_TEXT[template.isolation]}</p>
          <p>{PERSONAL_STATEMENT}</p>
        </div>
      ) : null}
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Connection name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        {saved ? (
          <div className={styles.field}>
            <span>Computer running the connector</span>
            <strong>
              {connectors.find((c) => c.id === saved.connectorId)?.name ?? 'Another computer'}
            </strong>
          </div>
        ) : (
          <label className={styles.field}>
            <span>Computer running the connector</span>
            <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.online ? c.name : `${c.name} (offline)`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.field}>
          <span>Your account on {template ? hostLabel(template) : 'this computer'}</span>
          <input value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
        </label>
        {template?.target.jump ? (
          <label className={styles.field}>
            <span>Your account on {template.target.jump.host}, if different</span>
            <input
              value={jumpUser}
              autoComplete="off"
              onChange={(e) => setJumpUser(e.target.value)}
            />
          </label>
        ) : null}
      </div>
      {template ? (
        <p className={styles.muted}>
          Working directory: <span className={styles.mono}>{workspace}</span>
        </p>
      ) : null}
      <fieldset className={styles.fieldset}>
        <legend>Your key</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name={`${id}-auth`}
            checked={method === 'key'}
            onChange={() => setMethod('key')}
          />
          Key file on the connector's computer
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name={`${id}-auth`}
            checked={method === 'agent'}
            onChange={() => setMethod('agent')}
          />
          One key from the SSH agent on the connector's computer
        </label>
        {method === 'key' ? (
          <label className={styles.field}>
            <span>Key file path</span>
            <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
          </label>
        ) : (
          <label className={styles.field}>
            <span>Agent key comment or fingerprint</span>
            <input value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
        )}
        <span className={styles.muted}>
          A passphrase or second factor is typed in the connector's terminal, never here.
        </span>
      </fieldset>
      <div className={styles.row}>
        <button
          type="submit"
          className={buttons.primary}
          disabled={busy || connectors.length === 0}
        >
          Save and test connection
        </button>
      </div>
    </form>
  );
}
