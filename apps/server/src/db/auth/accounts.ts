import type { Db } from '../client';
import { users } from '../schema';

/**
 * The account for an address whose control was just proved. A first sign-in creates the
 * account with no memberships: roles come only from enrolment codes and invitations (§3).
 */
export async function userForVerifiedEmail(db: Db, email: string): Promise<string> {
  const address = email.toLowerCase();
  const name = address.slice(0, address.indexOf('@')) || address;
  // The no-op update makes RETURNING yield the id for an existing account too.
  const [row] = await db
    .insert(users)
    .values({ email: address, name })
    .onConflictDoUpdate({ target: users.email, set: { email: address } })
    .returning({ id: users.id });
  if (!row) throw new Error('user upsert returned no row');
  return row.id;
}
