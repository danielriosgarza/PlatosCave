import type { InteractiveView } from '@parallax/contracts';
import { Categorize } from './Categorize';
import { Drawing } from './Drawing';
import type { InteractiveDraft } from './draft';
import { FillBlanks } from './FillBlanks';
import { GridCells } from './GridCells';
import { Hotspot } from './Hotspot';
import { LabelDiagram } from './LabelDiagram';
import { Manipulate } from './Manipulate';
import { PlotPoints } from './PlotPoints';
import { SketchGraph } from './SketchGraph';

export interface InteractiveFormProps {
  view: InteractiveView;
  draft: InteractiveDraft;
  disabled: boolean;
  /** Per-part marks of the last check, while the draft is still the response that was checked. */
  parts?: Record<string, boolean> | null;
  /** Names the step's drawing when its scene has no description. */
  label: string;
  onChange: (draft: InteractiveDraft) => void;
}

/** The answer area of an interactive step (§9): one component per kind. */
export function InteractiveForm({
  view,
  draft,
  disabled,
  parts,
  label,
  onChange,
}: InteractiveFormProps) {
  const common = { disabled, parts, label };
  switch (view.kind) {
    case 'categorize':
      return draft.kind === view.kind ? (
        <Categorize view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'fill_blanks':
      return draft.kind === view.kind ? (
        <FillBlanks view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'label_diagram':
      return draft.kind === view.kind ? (
        <LabelDiagram view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'plot_points':
      return draft.kind === view.kind ? (
        <PlotPoints view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'sketch_graph':
      return draft.kind === view.kind ? (
        <SketchGraph view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'hotspot':
      return draft.kind === view.kind ? (
        <Hotspot view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'grid':
      return draft.kind === view.kind ? (
        <GridCells view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'manipulate':
    case 'explore':
      return draft.kind === view.kind ? (
        <Manipulate view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
    case 'drawing':
      return draft.kind === view.kind ? (
        <Drawing view={view} draft={draft} onChange={onChange} {...common} />
      ) : null;
  }
}
