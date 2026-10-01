/** Input that only a reader makes: after it, scrolling is theirs and the place follows it. */
export const READER_INPUT = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

/**
 * How long a restored place is held against scrolls nobody made (the router's reset to the top,
 * late images, a browser's restoration). After it, any scroll is the reader's: a scrollbar drag
 * sends no input event in every browser, so input alone cannot be the signal.
 */
export const HOLD_MS = 1500;
