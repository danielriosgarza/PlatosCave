import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { CustomFetch } from 'openid-client';

/**
 * An OpenID Connect issuer that runs in the test process (ADR-0002, Amendment: Identity
 * providers). It is reached only through `identityFetch`, so no test touches the network. The
 * issuer, the client and its secret are fictional; none is a credential.
 */
export const ISSUER = 'https://issuer.example.test';
export const CLIENT = { id: 'parallax-test', secret: 'fixture-secret-not-a-credential' };

export const UNIVERSITY = {
  id: 'university',
  name: 'Example University',
  issuer: ISSUER,
  clientId: CLIENT.id,
};
export const HOSPITAL = { ...UNIVERSITY, id: 'hospital', name: 'Example Hospital' };

/** The environment that configures these providers, each with the fixture's client secret. */
export const providerEnv = (...providers: { id: string }[]) => ({
  OIDC_PROVIDERS: JSON.stringify(providers),
  OIDC_CLIENT_SECRETS: JSON.stringify(
    Object.fromEntries(providers.map((p) => [p.id, CLIENT.secret])),
  ),
});

/**
 * How the issuer answers one approval: claims that replace the defaults (a value of `undefined`
 * removes the claim), a signature by a key outside its published set, or no signature at all.
 */
export interface Grant {
  claims?: Record<string, unknown>;
  key?: 'stranger';
  alg?: 'none';
}

interface Issued {
  redirectUri: string;
  challenge: string;
  nonce: string;
  grant: Grant;
  used: boolean;
}

const b64u = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Issuer = ReturnType<typeof createIssuer>;

export function createIssuer() {
  const own = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map<string, Issued>();

  // Times come from the real clock: openid-client checks `exp` and `iat` against it.
  function idToken({ nonce, grant }: Issued): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER,
      sub: 'subject-ana',
      aud: CLIENT.id,
      iat: now,
      exp: now + 300,
      nonce,
      email: 'ana@example.org',
      email_verified: true,
      ...grant.claims,
    };
    const alg = grant.alg ?? 'RS256';
    const signed = `${b64u(JSON.stringify({ alg, kid: 'k1', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
    if (alg === 'none') return `${signed}.`;
    const key = grant.key === 'stranger' ? stranger.privateKey : own.privateKey;
    return `${signed}.${b64u(sign('sha256', Buffer.from(signed), key))}`;
  }

  /** The token endpoint: Basic client authentication, a known unused code, its redirect and PKCE. */
  function token(form: URLSearchParams, authorization: string | null): Response {
    // RFC 6749 §2.3.1: both halves are form-encoded before base64.
    const basic = Buffer.from(authorization?.replace(/^Basic /, '') ?? '', 'base64').toString();
    const [id, secret] = basic.split(':').map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
    if (id !== CLIENT.id || secret !== CLIENT.secret) {
      return json({ error: 'invalid_client' }, 401);
    }
    const issued = codes.get(form.get('code') ?? '');
    const challenge = b64u(
      createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest(),
    );
    if (
      !issued ||
      issued.used ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== issued.redirectUri ||
      challenge !== issued.challenge
    ) {
      return json({ error: 'invalid_grant' }, 400);
    }
    issued.used = true;
    return json({
      access_token: b64u(randomBytes(16)),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken(issued),
    });
  }

  const issuer = {
    /** While set, every request fails as one to a host that cannot be reached. */
    unreachable: false,
    fetch: (async (url, options) => {
      if (issuer.unreachable) throw new TypeError('fetch failed');
      switch (`${options.method} ${url}`) {
        case `GET ${ISSUER}/.well-known/openid-configuration`:
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
          });
        case `GET ${ISSUER}/jwks`:
          return json({
            keys: [
              { ...own.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' },
            ],
          });
        case `POST ${ISSUER}/token`:
          return token(
            new URLSearchParams(String(options.body)),
            new Headers(options.headers).get('authorization'),
          );
        default:
          throw new Error(`the test issuer serves no ${options.method} ${url}`);
      }
    }) satisfies CustomFetch,
    /** The person signs in at the issuer: the callback URL it sends the browser back to. */
    approve(authorize: string, grant: Grant = {}): URL {
      const url = new URL(authorize);
      const q = url.searchParams;
      if (
        `${url.origin}${url.pathname}` !== `${ISSUER}/authorize` ||
        q.get('response_type') !== 'code' ||
        q.get('client_id') !== CLIENT.id ||
        q.get('scope') !== 'openid email' ||
        q.get('code_challenge_method') !== 'S256'
      ) {
        throw new Error(`not an authorization request this issuer accepts: ${authorize}`);
      }
      const code = b64u(randomBytes(16));
      const redirectUri = q.get('redirect_uri') ?? '';
      codes.set(code, {
        redirectUri,
        challenge: q.get('code_challenge') ?? '',
        nonce: q.get('nonce') ?? '',
        grant,
        used: false,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      return back;
    },
  };
  return issuer;
}

type Reply = Awaited<ReturnType<FastifyInstance['inject']>>;

/** The Cookie header a browser sends back for the reply's Set-Cookie of `name`, if any. */
export function cookieOf(res: Reply, name: string): string | undefined {
  const value = res.cookies.find((c) => c.name === name)?.value;
  return value ? `${name}=${encodeURIComponent(value)}` : undefined;
}

export interface SignInOptions {
  provider?: string;
  next?: string;
  entrance?: 'student' | 'instructor';
  grant?: Grant;
  /** Cookies the browser already holds, such as a session. */
  cookie?: string;
}

/** A browser's start: the reply, the `pc_oidc` cookie it set and the issuer's callback URL. */
export async function startSignIn(app: FastifyInstance, issuer: Issuer, o: SignInOptions = {}) {
  const query = new URLSearchParams();
  if (o.next !== undefined) query.set('next', o.next);
  if (o.entrance) query.set('entrance', o.entrance);
  const start = await app.inject({
    method: 'GET',
    url: `/api/auth/oidc/${o.provider ?? 'university'}/start?${query}`,
    headers: o.cookie ? { cookie: o.cookie } : {},
  });
  const location = String(start.headers.location ?? '');
  const back = location.startsWith(ISSUER) ? issuer.approve(location, o.grant) : undefined;
  return { start, pending: cookieOf(start, 'pc_oidc'), back };
}

/** The issuer sends the browser back, carrying the cookies it holds. */
export function finishSignIn(app: FastifyInstance, back: URL, cookies: (string | undefined)[]) {
  const cookie = cookies.filter(Boolean).join('; ');
  return app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: cookie ? { cookie } : {},
  });
}

/** Start, approval at the issuer and callback, as one browser does them. */
export async function signInThroughIssuer(
  app: FastifyInstance,
  issuer: Issuer,
  o: SignInOptions = {},
) {
  const { start, pending, back } = await startSignIn(app, issuer, o);
  if (!back) throw new Error(`start answered ${start.statusCode} ${start.headers.location}`);
  const callback = await finishSignIn(app, back, [o.cookie, pending]);
  return { start, pending, back, callback, session: cookieOf(callback, 'pc_session') };
}
