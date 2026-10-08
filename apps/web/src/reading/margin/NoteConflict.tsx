import { ConflictBox } from '../../components/ConflictBox';
import type { NoteController } from './notes';

/** The conflict choice of a note, shared by the reading margin and the slide notes. */
export function NoteConflict({
  controller,
  mine,
  saved,
}: {
  controller: NoteController | undefined;
  mine: string;
  saved: string;
}) {
  return (
    <ConflictBox
      title="This note changed somewhere else"
      versions={[
        { label: 'Your text on this device', text: mine },
        { label: 'Saved version', text: saved },
      ]}
      keepLabel="Keep my text"
      useLabel="Use the saved version"
      onKeep={() => controller?.keepMine()}
      onUse={() => controller?.takeSaved()}
    />
  );
}
