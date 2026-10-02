import { describe, expect, test } from 'vitest';
import { isProcessed, isRasterOnly } from './reading-ingest.job';

describe('isRasterOnly', () => {
  test('a deck with no text on any page is raster-only', () => {
    expect(isRasterOnly([{ text: '' }, { text: ' \n' }])).toBe(true);
  });

  test('a deck with text on at least half of its pages is not', () => {
    expect(isRasterOnly([{ text: 'Intro' }, { text: '' }])).toBe(false);
    expect(isRasterOnly([{ text: 'Intro' }, { text: '' }, { text: '' }])).toBe(true);
  });
});

describe('isProcessed', () => {
  test('readings and PDF decks have a job; other types do not', () => {
    expect(['reading_native', 'reading_pdf', 'slides_pdf'].every(isProcessed)).toBe(true);
    expect(['slides_web', 'test', 'shiny'].some(isProcessed)).toBe(false);
  });
});
