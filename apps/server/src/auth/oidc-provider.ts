import type { FastifyBaseLogger } from 'fastify';
import * as client from 'openid-client';
import { z } from 'zod';
import type { Config } from '../config';
import type { IdentityProvider, SignInResult } from './identity-provider';

/** A sign-in waiting for the issuer, kept by the browser that started it (cookie `pc_oidc`). */
export const PendingSignIn = z.strictObject({
  provider: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  destination: z.string(),
  startedAt: z.number().int(),
});
export type PendingSignIn = z.infer<typeof PendingSignIn>;

const Verified = z.object({ email: z.email().max(254), email_verified: z.literal(true) });

/** The account key: the lower-cased `email`, if an address whose `email_verified` is `true`. */
export function verifiedAddress(claims: unknown): string | null {
  const parsed = Verified.safeParse(claims);
  return parsed.success ? parsed.data.email.toLowerCase() : null;
}

type Started = { url: URL; pending: PendingSignIn };
type Proof = { callback: URL; pending: PendingSignIn };

/** A generic OpenID Connect issuer: the authorization code flow with PKCE, state and nonce. */
export class OidcProvider implements IdentityProvider<{ destination: string }, Started, Proof> {
  readonly id: string;
  private discovered: Promise<client.Configuration> | undefined;

  constructor(
    private readonly deps: {
      settings: Config['OIDC_PROVIDERS'][number];
      redirectUri: URL;
      fetch?: client.CustomFetch;
      now: () => Date;
      log: FastifyBaseLogger;
    },
  ) {
    this.id = deps.settings.id;
  }

  /** Discovered at the first start and kept; a failed discovery is not kept. */
  private configuration(): Promise<client.Configuration> {
    if (!this.discovered) {
      const { issuer, clientId, clientSecret } = this.deps.settings;
      const auth = client.ClientSecretBasic(clientSecret);
      const fetch = this.deps.fetch && { [client.customFetch]: this.deps.fetch };
      this.discovered = client.discovery(new URL(issuer), clientId, {}, auth, fetch).then((c) => {
        // Otherwise openid-client takes the ID token's signature on trust; now the keys at the
        // issuer's jwks_uri check it.
        client.enableNonRepudiationChecks(c);
        return c;
      });
      this.discovered.catch(() => {
        this.discovered = undefined;
      });
    }
    return this.discovered;
  }

  async begin({ destination }: { destination: string }): Promise<Started> {
    const config = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.deps.redirectUri.href,
      scope: 'openid email',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const startedAt = this.deps.now().getTime();
    return { url, pending: { provider: this.id, state, nonce, verifier, destination, startedAt } };
  }

  /**
   * Checks the callback (`state`, `iss` when sent, an error the issuer reports), exchanges the
   * code with the client secret, checks the ID token (signature, `iss`, `aud`, `azp`, `exp`,
   * `iat`, `nonce`, algorithm), then requires a verified address.
   */
  async complete({ callback, pending }: Proof): Promise<SignInResult> {
    let claims: unknown;
    try {
      // A record that a start at another provider wrote (mix-up) never reaches this issuer.
      if (pending.provider !== this.id) throw new Error('another provider');
      const tokens = await client.authorizationCodeGrant(await this.configuration(), callback, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (err) {
      return this.refused(pending, 'failed', (err as { code?: unknown } | undefined)?.code);
    }
    const email = verifiedAddress(claims);
    if (!email) return this.refused(pending, 'unverified');
    return { ok: true, email, destination: pending.destination };
  }

  /** Logs no claim and no address; openid-client's error code helps the operator. */
  private refused({ destination }: PendingSignIn, reason: 'unverified' | 'failed', code?: unknown) {
    this.deps.log.info({ provider: this.id, reason, code }, 'provider sign-in refused');
    return reason === 'unverified'
      ? { ok: false as const, destination, reason }
      : { ok: false as const, destination };
  }
}
