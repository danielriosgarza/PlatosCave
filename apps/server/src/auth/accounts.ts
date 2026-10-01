import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users } from '../db/schema';

/**
 * The account for an address whose control was just proved. A first sign-in creates the
 * account with no memberships: roles come only from enrolment codes and invitations (§3).
 */
export async function userForVerifiedEmail(db: Db, email: string): Promise<string> {
  const address = email.toLowerCase();
  const name = address.slice(0, address.indexOf('@')) || address;
  await db.insert(users).values({ email: address, name }).onConflictDoNothing();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, address));
  if (!row) throw new Error('verified account could not be loaded');
  return row.id;
}
