import { type RefObject, useEffect, useRef } from 'react';

type Kind = 'idle' | 'loading' | 'preview' | 'sending' | 'done' | 'error';

/**
 * Focus for a release preview (§14): into the preview heading when it opens, back to the
 * invoking control on Cancel (or to `fallback` when that control is disabled), and to the
 * outcome after a release or a failed preview.
 */
export function useReleasePreviewFocus<R extends HTMLElement>(
  kind: Kind,
  fallback?: RefObject<HTMLElement | null>,
) {
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const result = useRef<R>(null);
  const shown = useRef<Kind>('idle');
  useEffect(() => {
    const was = shown.current;
    shown.current = kind;
    if (kind === 'preview' && was !== 'preview') heading.current?.focus();
    else if (kind === 'idle' && (was === 'preview' || was === 'sending')) {
      if (trigger.current && !trigger.current.disabled) trigger.current.focus();
      else fallback?.current?.focus();
    } else if (kind === 'done' || (kind === 'error' && (was === 'sending' || was === 'loading')))
      result.current?.focus();
  }, [kind, fallback]);
  return { trigger, heading, result };
}
