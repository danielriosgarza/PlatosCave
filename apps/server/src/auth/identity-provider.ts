/**
 * An identity service (§3: "Both use the same identity service"). Email links are the only
 * provider today; institutional sign-in is a later provider decision and implements this too.
 */
export interface IdentityProvider {
  readonly id: string;
  /**
   * Starts a sign-in for `email`, preserving `destination`. Never reveals whether an account
   * exists: the caller answers the same way for every address.
   */
  begin(input: { email: string; destination: string }): Promise<void>;
  /** Finishes a sign-in from the provider's proof (here, the link token). */
  complete(proof: string): Promise<SignInResult>;
}

export type SignInResult =
  | { ok: true; email: string; destination: string }
  /** Unknown, used or expired proof; `destination` is kept when the proof was recognised. */
  | { ok: false; destination: string | null };
