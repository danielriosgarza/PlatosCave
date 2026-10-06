import { type KeyboardEvent, useEffect, useRef } from 'react';

/**
 * Escape cancels the innermost open inline confirmation and nothing else: the handler marks the
 * event as handled, so the panel's own Escape (which closes it) leaves the form alone. Focus
 * returns to the button that opened the confirmation.
 */
export function useCancelOnEscape(open: boolean, cancel: () => void) {
  const trigger = useRef<HTMLButtonElement>(null);
  const escaped = useRef(false);
  useEffect(() => {
    if (open || !escaped.current) return;
    escaped.current = false;
    trigger.current?.focus();
  }, [open]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    escaped.current = true;
    cancel();
  };
  return { trigger, onKeyDown };
}
