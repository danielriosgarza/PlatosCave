import { readAssignment } from '@parallax/contracts/routes/tests';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import { RetryNotice } from '../components/RetryNotice';
import { useClassReview } from '../review/classReview';
import { grantAccommodation, useAssignment } from './api';
import { formatInZone } from './TermsPanel';
import styles from './Test.module.css';

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The part of a grant an instructor reads back: what was given, in words. */
function describe(
  g: { extraAttempts: number; extraMinutes: number; closesAt: string | null },
  zone: string,
) {
  const parts: string[] = [];
  if (g.extraAttempts > 0) {
    parts.push(`${g.extraAttempts} extra ${g.extraAttempts === 1 ? 'attempt' : 'attempts'}`);
  }
  if (g.extraMinutes > 0) parts.push(`${g.extraMinutes} extra minutes`);
  if (g.closesAt) parts.push(`closes ${formatInZone(g.closesAt, zone)}`);
  return parts.length > 0 ? parts.join(' · ') : 'No change to the terms';
}

/**
 * Extensions and extra attempts for one test (§11): an instructor grants one to a student with a
 * reason, and reads the grants in force with who, when and why. A grant replaces the one before it
 * and moves the deadline of an attempt in progress; the student then sees it in their terms.
 */
export function AccommodationsPanel({
  classId,
  resourceId,
}: {
  classId: string;
  resourceId: string;
}) {
  const queryClient = useQueryClient();
  const assignment = useAssignment(classId, resourceId);
  const roster = useClassReview(classId, {});
  const [studentId, setStudentId] = useState('');
  const [attempts, setAttempts] = useState('0');
  const [minutes, setMinutes] = useState('0');
  const [closesAt, setClosesAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [granted, setGranted] = useState<string | null>(null);

  if (assignment.isError) {
    return (
      <RetryNotice
        message="Extensions could not be loaded."
        onRetry={() => void assignment.refetch()}
      />
    );
  }
  if (!assignment.data) return <Loading label="Loading extensions" className={styles.small} />;
  const zone = assignment.data.effective.timeZone;
  const students = roster.data?.roster ?? [];

  const extraAttempts = Number(attempts);
  const extraMinutes = Number(minutes);
  const changes = extraAttempts > 0 || extraMinutes > 0 || closesAt !== '';
  const valid =
    studentId !== '' &&
    reason.trim() !== '' &&
    Number.isInteger(extraAttempts) &&
    Number.isInteger(extraMinutes) &&
    changes;

  async function grant() {
    if (busy || !valid) return;
    setBusy(true);
    setProblem(null);
    setGranted(null);
    try {
      const closes = closesAt ? new Date(closesAt) : null;
      const result = await grantAccommodation(classId, resourceId, {
        studentId,
        extraAttempts,
        extraMinutes,
        closesAt: closes && !Number.isNaN(closes.getTime()) ? closes.toISOString() : null,
        reason: reason.trim(),
      });
      setGranted(`Granted to ${result.student.name}: ${describe(result, zone)}.`);
      setStudentId('');
      setAttempts('0');
      setMinutes('0');
      setClosesAt('');
      setReason('');
      await queryClient.invalidateQueries({
        queryKey: [readAssignment.method, readAssignment.path],
      });
    } catch (error) {
      const code =
        error instanceof ApiError ? (error.body as { error?: string } | null)?.error : '';
      setProblem(
        code === 'class_archived'
          ? 'This class is archived, so nothing can be granted.'
          : 'The grant was not recorded. Check the values and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const overrides = assignment.data.overrides;
  return (
    <section aria-label="Extensions and extra attempts">
      <h3 style={{ font: 'var(--pc-text-subsection)', margin: '24px 0 8px' }}>
        Extensions and extra attempts
      </h3>
      <p className={`${styles.small} ${styles.muted}`}>
        A grant replaces the student's earlier one and moves the deadline of an attempt in progress.
        Times are shown in {zone}.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void grant();
        }}
        style={{ maxWidth: 520, display: 'grid', gap: 12 }}
      >
        <label>
          Student
          <select value={studentId} onChange={(event) => setStudentId(event.target.value)} required>
            <option value="">Choose a student</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Extra attempts
          <input
            type="number"
            min={0}
            max={20}
            value={attempts}
            onChange={(event) => setAttempts(event.target.value)}
          />
        </label>
        <label>
          Extra minutes
          <input
            type="number"
            min={0}
            max={7 * 24 * 60}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <label>
          New closing time ({browserZone}, your browser's time zone)
          <input
            type="datetime-local"
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </label>
        <label>
          Grant reason, shown in the audit history
          <input
            type="text"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        <p className={styles.row}>
          <button type="submit" className={buttons.primary} disabled={busy || !valid}>
            {busy ? 'Granting…' : 'Grant'}
          </button>
        </p>
        {problem ? (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        ) : null}
        {granted ? <p role="status">{granted}</p> : null}
      </form>
      {overrides.length === 0 ? (
        <p className={styles.small}>No extension or extra attempt has been granted.</p>
      ) : (
        <ul className={styles.attempts} aria-label="Grants in force">
          {overrides.map((o) => (
            <li key={o.id} className={styles.block}>
              <strong>{o.student.name}</strong> · {describe(o, zone)}
              <br />
              <span className={`${styles.small} ${styles.muted}`}>
                Reason: {o.reason} · granted {formatInZone(o.createdAt, zone)} by an instructor
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
