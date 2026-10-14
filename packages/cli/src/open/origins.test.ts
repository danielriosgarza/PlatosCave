import { expect, test } from 'vitest';
import { assertSeparateHosts } from './origins';
import { BuildStop } from './output';

delete process.env.DATABASE_URL;
const site = 'https://site.example.org';

test.each([
  ['another port', site, 'https://site.example.org:8443'],
  ['another scheme', site, 'http://site.example.org'],
  ['another case', site, 'https://SITE.Example.ORG'],
  ['a trailing dot', site, 'https://site.example.org.'],
  ['a trailing dot, another case and another port', site, 'https://Site.example.org.:8443'],
  ['its punycode spelling', 'https://bücher.example.org', 'https://xn--bcher-kva.example.org'],
  ['another port on the loopback name', 'http://localhost:4310', 'http://localhost:4311'],
  ['no origin to compare it with', site, 'content.example.org'],
])('the same host with %s stops and names both origins', (_name, app, content) => {
  for (const origins of [
    { app, content },
    { app: content, content: app },
  ]) {
    const stopped = () => assertSeparateHosts(origins);
    expect(stopped).toThrow(BuildStop);
    expect(stopped).toThrow(`origins.app (${origins.app})`);
    expect(stopped).toThrow(`origins.content (${origins.content})`);
  }
});

test.each([
  [site, 'https://content.site.example.org'],
  ['http://127.0.0.1:4175', 'http://localhost:4176'],
])('%s and %s have two host names and pass', (app, content) => {
  expect(assertSeparateHosts({ app, content })).toBeUndefined();
  expect(assertSeparateHosts({ app: content, content: app })).toBeUndefined();
});
