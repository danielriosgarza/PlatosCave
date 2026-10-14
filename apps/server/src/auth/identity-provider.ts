/**
 * An identity service (§3: "Both use the same identity service"): email links and OpenID Connect
 * (`OidcProvider`; ADR-0002, Amendment: Identity providers). The defaults are the link's types.
 */
export interface IdentityProvider<
  Begin = { email: string; destination: string },
  Started = void,
  Proof = string,
> {
  readonly id: string;
  /**
   * Starts a sign-in, preserving `destination`. An email link never reveals whether an account
   * exists: the caller answers the same way for every address.
   */
  begin(input: Begin): Promise<Started>;
  /**
   * Finishes a sign-in from the provider's proof (a token or a callback). Does not validate the
   * proof's shape: the caller rejects malformed input first (the verify route does), so
   * arbitrary input never costs a query.
   */
  complete(proof: Proof): Promise<SignInResult>;
}

export type SignInResult =
  | { ok: true; email: string; destination: string }
  /** Unknown, used or expired proof; `destination` is kept when the proof was recognised. */
  | { ok: false; destination: string | null; reason?: 'unverified' };
