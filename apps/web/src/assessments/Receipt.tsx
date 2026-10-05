import buttons from '../components/Buttons.module.css';
import type { AttemptView, Question } from './api';
import { formatInZone } from './TermsPanel';
import styles from './Test.module.css';

type Local = 'none' | 'sending' | 'kept' | 'failed';

const questionName = (questions: Question[], id: string) => {
  const index = questions.findIndex((q) => q.id === id);
  return index >= 0 ? `Question ${index + 1}` : id;
};

/**
 * The receipt (§11): shown only for a submission the server has stored. It says which answers
 * the server received and, for an auto-submission, what happened to work still in the browser.
 */
export function ReceiptView({
  attempt,
  unsentCount,
  local,
  onRetryLocal,
  onDownload,
}: {
  attempt: AttemptView;
  /** Answers the browser still held that the server never acknowledged. */
  unsentCount: number;
  local: Local;
  onRetryLocal: () => void;
  onDownload: () => void;
}) {
  const receipt = attempt.receipt;
  const zone = attempt.terms.timeZone;
  if (!receipt) {
    // Closed without a stored submission cannot happen for a submitted state; say so rather than guess.
    return (
      <div className={styles.receipt}>
        <h2>This attempt is closed</h2>
        <p>The server has no receipt for it. Ask your instructor to check attempt {attempt.id}.</p>
      </div>
    );
  }
  const answered = receipt.answers.length;
  return (
    <div className={styles.receipt}>
      <h2 tabIndex={-1} id="pc-receipt-heading">
        {receipt.autoSubmitted ? 'Time ran out · your saved answers were submitted' : 'Test submitted'}
      </h2>
      <p role="status">
        {receipt.autoSubmitted
          ? `At the deadline the server submitted the answers it had saved. It received ${answered} ${
              answered === 1 ? 'answer' : 'answers'
            }.`
          : `The server received ${answered} ${answered === 1 ? 'answer' : 'answers'}.`}
      </p>
      <dl className={styles.receiptList}>
        <dt>Submitted</dt>
        <dd>{formatInZone(receipt.submittedAt, zone)}</dd>
        <dt>Attempt</dt>
        <dd>
          {attempt.number} · ID {receipt.attemptId}
        </dd>
        <dt>Receipt</dt>
        <dd>{receipt.submissionId}</dd>
        <dt>Timing</dt>
        <dd>
          {receipt.autoSubmitted ? 'Submitted by the server at the deadline' : 'Submitted by you'}
          {receipt.late ? ' · late' : ''}
        </dd>
        <dt>Received</dt>
        <dd>
          {answered === 0
            ? 'No answers'
            : receipt.answers
                .map(
                  (a) =>
                    `${questionName(attempt.questions, a.questionId)} (saved ${formatInZone(
                      a.savedAt,
                      zone,
                    )})`,
                )
                .join('; ')}
        </dd>
        <dt>Not received</dt>
        <dd>
          {receipt.unanswered.length === 0
            ? 'None: every question has a saved answer'
            : receipt.unanswered.map((id) => questionName(attempt.questions, id)).join(', ')}
        </dd>
      </dl>
      {unsentCount > 0 || attempt.localCopyAt ? (
        <div className={styles.notice}>
          <p>
            <strong>Unsent changes are not part of this submission.</strong>{' '}
            {unsentCount > 0
              ? `${unsentCount} ${unsentCount === 1 ? 'answer was' : 'answers were'} changed after the last save and never reached the server.`
              : 'Some changes were made after the last save and never reached the server.'}
          </p>
          <p role="status">
            {local === 'sending'
              ? 'Keeping your unsent changes for your instructor…'
              : local === 'failed'
                ? 'Your unsent changes could not be sent yet. They are still in this browser.'
                : attempt.localCopyAt
                  ? `Your unsent changes were kept for your instructor at ${formatInZone(
                      attempt.localCopyAt,
                      zone,
                    )}. They are not submitted; your instructor can restore them on request.`
                  : 'Your unsent changes are in this browser only.'}
          </p>
          {local === 'failed' ? (
            <p className={styles.row}>
              <button type="button" className={buttons.outline} onClick={onRetryLocal}>
                Retry
              </button>
              <button type="button" className={buttons.outline} onClick={onDownload}>
                Download what you wrote
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
