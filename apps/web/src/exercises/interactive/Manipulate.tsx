import {
  formatNumber,
  type InteractiveView,
  type Param,
  type ParamValue,
  paramScope,
} from '@parallax/contracts';
import { useId, useRef, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import { type InteractiveDraft, initialValue, snapParam } from './draft';
import { Handle } from './Handle';
import styles from './Interactive.module.css';
import { useFrames } from './motion';
import { Scene } from './Scene';

type View = Extract<InteractiveView, { kind: 'manipulate' | 'explore' }>;
type Draft = Extract<InteractiveDraft, { kind: 'manipulate' | 'explore' }>;
type Slider = Exclude<Param, { kind: 'point' }>;

const show = (p: Param, v: ParamValue) =>
  Array.isArray(v)
    ? `(${formatNumber(v[0])}, ${formatNumber(v[1])})`
    : `${formatNumber(v)}${p.kind !== 'point' && p.unit ? ` ${p.unit}` : ''}`;

/**
 * A scene driven by parameters (§9): sliders below it, and handles in it for point parameters.
 * A slider with `animate` has Play, which runs it from its value to the end and round again,
 * through the values the slider offers: a sample size of 6.45 is never drawn.
 */
export function Manipulate({
  view,
  draft,
  disabled,
  label,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  label: string;
  onChange: (draft: Draft) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const values = draft.values;
  // A playing slider sets a value every frame: each builds on the values last set.
  const latest = useRef(values);
  latest.current = values;
  const set = (name: string, v: ParamValue) => {
    latest.current = { ...latest.current, [name]: v };
    onChange({ kind: draft.kind, values: latest.current });
  };
  const scope = paramScope(view.params, values);

  const running = view.params.find((p): p is Slider => p.name === playing && p.kind !== 'point');
  const from = useRef(0);
  useFrames(running !== undefined && !disabled, (seconds) => {
    if (!running?.animate) return;
    const span = running.max - running.min;
    const travelled = from.current + (seconds / running.animate.seconds) * span;
    if (!running.animate.loop && travelled >= span) {
      set(running.name, snapParam(running, running.max));
      setPlaying(null);
      return;
    }
    const v = snapParam(running, running.min + (travelled % span));
    if (v !== latest.current[running.name]) set(running.name, v);
  });

  const toggle = (p: Slider) => {
    if (playing === p.name) {
      setPlaying(null);
      return;
    }
    const v = latest.current[p.name];
    const at = typeof v === 'number' ? v : p.initial;
    // Played to the end without a loop, Play starts over.
    from.current = !p.animate?.loop && at >= snapParam(p, p.max) ? 0 : at - p.min;
    setPlaying(p.name);
  };

  return (
    <div className={styles.board}>
      <Scene scene={view.scene} scope={scope} label={label} interactive={!disabled}>
        {(frame) =>
          view.params.map((p) => {
            if (p.kind !== 'point') return null;
            const v = values[p.name];
            const at = (Array.isArray(v) ? v : p.initial) as [number, number];
            return (
              <Handle
                key={p.name}
                frame={frame}
                at={at}
                name={p.label}
                valueText={`${p.label} at ${show(p, at)}`}
                valueNow={at[0]}
                range={p.x}
                disabled={disabled}
                onDrag={(world) => set(p.name, snapParam(p, world))}
                onKey={([dx, dy]) => {
                  set(p.name, snapParam(p, [at[0] + dx * p.step, at[1] + dy * p.step]));
                  return true;
                }}
              />
            );
          })
        }
      </Scene>
      {view.params.some((p) => p.kind !== 'point') ? (
        <div className={styles.sliders}>
          {view.params.map((p) =>
            p.kind === 'point' ? null : (
              <SliderControl
                key={p.name}
                param={p}
                value={(values[p.name] as number | undefined) ?? (initialValue(p) as number)}
                playing={playing === p.name}
                disabled={disabled}
                onChange={(v) => {
                  if (playing === p.name) setPlaying(null);
                  set(p.name, snapParam(p, v));
                }}
                onPlay={() => toggle(p)}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function SliderControl({
  param: p,
  value,
  playing,
  disabled,
  onChange,
  onPlay,
}: {
  param: Slider;
  value: number;
  playing: boolean;
  disabled: boolean;
  onChange: (v: number) => void;
  onPlay: () => void;
}) {
  const id = useId();
  const last = snapParam(p, p.max) as number;
  return (
    <div className={styles.slider}>
      <label htmlFor={id} className={styles.sliderHead}>
        <span>{p.label}</span>
        <strong>{show(p, snapParam(p, value))}</strong>
      </label>
      <div className={styles.sliderRow}>
        <input
          id={id}
          type="range"
          min={p.min}
          max={last}
          step={p.step}
          value={value}
          disabled={disabled}
          aria-valuetext={`${p.label} ${show(p, snapParam(p, value))}`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {p.animate ? (
          <button type="button" className={buttons.outline} disabled={disabled} onClick={onPlay}>
            {playing ? 'Pause' : 'Play'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
