import { getObjectUrl } from '@parallax/contracts/routes/media';
import { useState } from 'react';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from './Reading.module.css';

interface Props {
  classId: string;
  revisionId: string;
  /** Storage key of the uploaded source file, from the reading. */
  sourceKey: string;
  className?: string;
  /** Button text and, with it, the accessible name; defaults to "Download". */
  label?: string;
}

/** Downloads a reading's source file through a short-lived attachment link from the class release. */
export function SourceDownload({ classId, revisionId, sourceKey, className, label }: Props) {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const { url } = await call(getObjectUrl, {
        params: { classId, revisionId, key: sourceKey },
        query: { disposition: 'attachment' },
      });
      window.location.assign(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className ?? buttons.tool}
        disabled={busy}
        onClick={() => void download()}
      >
        {label ?? 'Download'}
      </button>
      {failed && <span role="status">The file could not be downloaded.</span>}
    </>
  );
}
