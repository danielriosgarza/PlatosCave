import { describe, expect, test } from 'vitest';
import { shinyAddressProblem, shinyContentProblem } from './shiny';

describe('shiny address', () => {
  test('accepts https and http on loopback', () => {
    for (const url of [
      'https://shiny.example.org/app/?lang=en',
      'http://localhost:3838/',
      'http://127.0.0.1:3838/app',
      'http://[::1]:3838/',
    ]) {
      expect(shinyAddressProblem(url), url).toBeUndefined();
    }
  });

  test('refuses other schemes, plain http elsewhere, credentials and non-addresses', () => {
    for (const url of [
      'http://shiny.example.org/',
      'javascript:alert(1)',
      'ftp://shiny.example.org/',
      'https://user:secret@shiny.example.org/',
      'https://user@shiny.example.org/',
      'not an address',
      '',
    ]) {
      expect(shinyAddressProblem(url), url).toBeTypeOf('string');
    }
  });

  test('content must be an object with a string url', () => {
    expect(shinyContentProblem({ url: 'https://shiny.example.org/' })).toBeUndefined();
    for (const content of [null, [], 'https://x.org', {}, { url: 3 }, { url: '  ' }]) {
      expect(shinyContentProblem(content)).toBeTypeOf('string');
    }
  });
});
