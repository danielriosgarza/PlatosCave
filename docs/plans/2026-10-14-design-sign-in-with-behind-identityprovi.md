# Plan

## Goal

Run R4 of package development, owned by P5-12, designs "sign in with…" for N7 on the owner's answers Q24 and Q25. It produces three things.

1. The text of the ADR-0002 amendment **Amendment: Identity providers**, ready to paste.
2. The units of the run, each with its scope, files, scenario tests and size. They are **P5-12** (server) and **P5-13** (sign-in page and site configuration). P5-12 is estimated at about 580 counted lines, close to the limit. If its measured diff passes 600, only test cases with plain titles split off, as the added item **P5-12a** in session 2a, whose entry is written out here.
3. The plan lines that P5-12's pull request writes.

What gets built:

- A person can sign in with a configured generic OpenID Connect issuer, such as a university's issuer or Google.
- That sign-in reaches the account of the same verified address, the lower-cased `users.email` that link sign-in uses.
- An assertion without a verified address is refused, and the sign-in page explains why.
- A server can run with no mail sender. It then offers no email link.

Nothing built changes. With no provider configured and mail as today, every existing route, contract, default and screen behaves exactly as before.

## Approach

### 1. Decisions

**D1. One provider kind: generic OpenID Connect (Q24).**
- An issuer is configured by its issuer URL, a client id and a client secret.
- A university issuer and Google are two configurations of the same code.
- GitHub and ORCID are not built. They stay later items.

**D2. Behind `IdentityProvider`, with the email link unchanged.**
- `IdentityProvider` in `apps/server/src/auth/identity-provider.ts` gains three type parameters. Their defaults are today's types: `Begin = { email; destination }`, `Started = void` and `Proof = string`.
- So `EmailLinkProvider` still `implements IdentityProvider` as written, and `apps/server/src/auth/email-provider.ts` is not edited.
- The new `OidcProvider` (`apps/server/src/auth/oidc-provider.ts`) implements `IdentityProvider<{ destination }, { url; pending }, { callback: URL; pending }>`.
- The failure branch of `SignInResult` gains one optional field, `reason?: 'unverified'`. The email provider never sets it.

**D3. Accounts stay keyed by a verified address (Q25).**
- `verifiedAddress(claims)` returns the lower-cased `email` only when it is an address (`z.email().max(254)`) and `email_verified === true`, the boolean.
- A missing `email`, or an `email_verified` that is missing, `false`, `"true"` or anything else, gives `{ ok: false, reason: 'unverified' }`.
- The issuer's `sub` is not stored. No account linking exists, and `userForVerifiedEmail` finds or creates the account exactly as for a link.

**D4. The flow, on one exact dependency.**
- The library is `openid-client` 6.8.8. It is pinned exactly in `apps/server/package.json` and recorded in ADR-0001's version table ("Choice (exact version)"), as every third-party package is. Its two dependencies, `jose` 6.2.12 and `oauth4webapi` 3.8.x, arrive through `pnpm-lock.yaml`. The versions were read from npm on 2026-10-14; 6.8.8 was published on 2026-09-05.
- The flow is the authorization code flow:
  - PKCE `S256` (`randomPKCECodeVerifier`, `calculatePKCECodeChallenge`), plus `randomState` and `randomNonce`;
  - `scope=openid email`;
  - the query response mode, never `form_post`;
  - client authentication `client_secret_basic` (`ClientSecretBasic`).
- Discovery (`discovery()`) runs on the first start of a provider, not at boot. The configuration is cached, and a failed discovery is not cached, so the next start asks again.
- **`enableNonRepudiationChecks(config)` is called on the discovered configuration.** By default openid-client does not verify the JWS signature of an ID token that comes from the token endpoint. With this call, the token is checked against the keys at the issuer's `jwks_uri`.
- `authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true }, { redirect_uri })` checks:
  - `state`, and the `iss` response parameter when the issuer advertises it;
  - the code exchange;
  - `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, and the algorithm (RS256 by default, so `none` and HS256 are refused).
- The fetch used for discovery, keys and tokens is injectable: `Deps.identityFetch` in `apps/server/src/app.ts`. It is set as openid-client's `customFetch` on the discovery call and on the returned configuration. Tests pass the in-process issuer here.

**D5. Pending sign-in state lives in the browser, not in a table.**
- The start route sets the cookie `pc_oidc`. Its value is the JSON `{ provider, state, nonce, verifier, destination, startedAt }`, where `startedAt` is the injected `now` of the start.
- The cookie is:
  - signed with `SESSION_SECRET` (`@fastify/cookie`, `signed: true`);
  - HttpOnly and `SameSite=Lax`;
  - `Secure` when `APP_ORIGIN` is https, as `sessionCookieOptions` decides;
  - limited to `Path=/api/auth/oidc` and `Max-Age=600`.
- The callback reads it with `req.unsignCookie` and the strict zod schema `PendingSignIn`. It clears the cookie on every answer.
- The cookie binds the flow to the browser. The callback refuses, before any code exchange:
  - a browser that did not start the flow, which has no cookie (login CSRF);
  - a cookie whose signature fails;
  - a cookie for another provider (mix-up);
  - a `state` that differs from the cookie's;
  - a cookie whose `startedAt` is more than ten minutes before the callback's `now`. The browser drops the cookie after `Max-Age`, and this check also refuses a copied cookie.
- A reused attempt is refused by the issuer, which accepts each code once. The in-process issuer enforces this as a real one does.
- The server keeps no pending state. A restart of the server during a sign-in loses nothing, because the record is in the browser and is checked with `SESSION_SECRET`, which survives the restart. If `SESSION_SECRET` changed in between, the cookie does not verify, the callback answers `refused=failed`, and the person starts again.
- The record is signed, not encrypted. The browser that holds it can read the verifier and the nonce, but these are useless without the code, which only that browser receives, and without the client secret.

**D6. Three public routes (K14).**
- Each route has a contract in `packages/contracts/src/routes/auth.ts`, declares `scope: { kind: 'public' }` and `examples`, and is registered through `registerRoute`:
  - `GET /api/auth/methods` returns `{ email: boolean, providers: [{ id, name }] }`, in configuration order. It never returns an issuer, a client id or a secret.
  - `GET /api/auth/oidc/:provider/start?next=&entrance=` answers 302 to the issuer's authorization endpoint.
  - `GET /api/auth/oidc/:provider/callback` answers 302 to the destination, or to `/signin?provider=<id>&refused=unverified|failed[&next=<kept path>]`.
- A provider id that is not configured answers `notFound()`, the shared 404.
- Start and callback reuse the link routes' rate-limit pattern and budgets: `{ rateLimit: { max: config.AUTH_LINK_RATE_LIMIT | AUTH_VERIFY_RATE_LIMIT, timeWindow: '15 minutes' } }`, with a declared 429.
- Query values are parsed with `.optional().catch(undefined)`, as `verifySignInLink` does. A browser holding a mangled URL still gets a redirect, never a JSON validation error.

**D7. The callback finishes through the existing sign-in path (P2). Its steps, in order:**
1. Run the code exchange and the ID token checks outside any transaction, so no pool connection is held while the issuer answers.
2. On `ok`, call `signInWithProof(db, { consume: async () => result, previous: readSessionToken(req), alsoEnd: (tx) => revokePreviewReturn(tx, req, at), now: at, ttlMs })`. That one existing transaction:
   - finds or creates the account (`userForVerifiedEmail`);
   - refuses a deactivated account (no token comes back, and the callback answers `refused=failed`, which says nothing about the account);
   - ends the earlier session (rotation) and the kept preview session;
   - creates the session with `auth_time = now`.
3. Set the cookie exactly as verify does (`SESSION_COOKIE`, `sessionCookieOptions`) and call `clearPreviewReturn`.
4. Redirect to `safeDestination(destination) ?? '/courses'`. At start, the destination was `safeDestination(next) ?? defaultDestination(entrance)`, so there is no open redirect.

**D8. Configuration (server) and optional mail (K8).**
- `providerSettings` is a strict zod object in `packages/contracts/src/routes/auth.ts`, shared by the server configuration and `siteConfig`. Its fields:
  - `id`, matching `^[a-z][a-z0-9-]{0,31}$`;
  - `name`, 1 to 60 characters, trimmed, no control characters;
  - `issuer`, an https URL with no query, fragment or credentials;
  - `clientId`, 1 to 255 characters.
- Being strict, it has no field for a logo or a colour.
- Two new variables in `apps/server/src/config.ts`:
  - `OIDC_PROVIDERS`: a JSON array of `providerSettings`, holding no secret. Ids must be unique, and the default is none.
  - `OIDC_CLIENT_SECRETS`: a JSON object from provider id to client secret. It is never committed and lives only in the git-ignored environment file.
- Start-up stops on a listed provider without a secret and on a secret for an unlisted id. The message names the id and never the secret.
- `config.OIDC_PROVIDERS` comes out of the transform with each provider's `clientSecret` merged in.
- `MAIL_TRANSPORT` becomes `file | smtp | none`, with the default still `file`. `none` needs at least one provider.
- `createMailer` gives `none` a sender that refuses, so it can never send.
- In `auth.routes.ts`:
  - `POST /api/auth/link` throws `serviceUnavailable()` (503) when `MAIL_TRANSPORT` is `none`. That is the branch it already has for a missing dependency, so the route never answers 202 and stores no link.
  - `/api/auth/verify` is untouched.
  - `GET /api/auth/methods` reports `email: MAIL_TRANSPORT !== 'none'`.

**D9. The sign-in page (P5-13).**
- **The provider control is a link, not a form.**
  - It is `<a className={buttons.outline} href="/api/auth/oidc/<id>/start?entrance=…&next=…">Sign in with {name}</a>`.
  - A form would be blocked: the app's CSP has `form-action 'self'`, and a form submission whose answer redirects to the issuer violates it.
  - `Buttons.module.css` already sizes anchors that carry `.outline` to 44 px under a coarse pointer ("Anchors styled as buttons are skipped by the global rule"), as `ShinyEmbed.tsx` does with `.tool`. No CSS file changes.
- **The route gets a `loader` that reads the methods before the page renders.**
  - It uses a plain `fetch` checked by the `signInMethods` schema. On any failure it falls back to `{ email: true, providers: [] }`, which is today's page.
  - It does not use `call()`. A 401 or 404 there notifies the session layer, which re-reads `/api/me`. The existing `preview.test.tsx` counts `/api/me` calls right after landing on `/signin`, and its stub answers 401 to every unknown URL.
  - With `autoCodeSplitting`, the route's component chunk already loads asynchronously, and the loader runs alongside it. `routeTree.gen.ts` does not change.
- **The email part is hidden without re-indenting the existing JSX (the diff stays small):**
  - The success-or-form ternary becomes `{!email ? null : request.isSuccess ? (…) : (…)}`.
  - The expired-link alert gains `email &&`.
  - The section label is `"Sign in with email"`, or `"Ways to sign in"` when providers exist.
- **The provider list** is a `<ul className={styles.bareListSpaced} aria-label="Sign in with another account">` after the form. It is rendered only when `providers.length > 0`. The existing entrance toggle stays where it is and serves both the email form and the providers.
- **The refusal explanation** is a `styles.feedback` block with `role="alert"`. It is shown only when the search names a configured provider (`?provider=<id>&refused=…`), so a site with no provider ignores those parameters. Copy:
  - `unverified`: heading "{name} did not confirm an email address", then "Parallax signs you in to the account of a confirmed email address. {name} did not send one, so this sign-in was refused." When email links are offered, it adds "You can ask for an email link below."
  - `failed`: heading "Signing in with {name} did not finish", then "Nothing was changed. Try again."
- No copy claims a success. A session exists only after the server's redirect, and the email acknowledgement still appears only after the link request's real 202, as today.

**D10. Site configuration (K24, the attach point R1 left in `docs/design/site.md` §13).** This is done in P5-13. P5-23a's and P5-23b's entries gain the matching lines.
- `siteConfig.signIn` becomes `{ email?: { from }, providers?: providerSettings[] }`, with ids unique.
- The rule "level 1 and above need signIn.email" becomes "level 1 and above need a way to sign in: signIn.email, signIn.providers or both". It is reported at the same path, `signIn`, so the existing case of `site.test.ts` keeps passing unmodified.
- At level 0, `signIn` stays unused: a level 0 site has no sign-in.
- **P5-23a** (`packages/cli/src/host/siteEnv.ts` and the command `start`):
  - `siteEnv.ts` emits provider settings only for the providers that `signIn.providers` lists. It writes them into `site.env` as `OIDC_PROVIDERS`, which holds no secret.
  - It writes `MAIL_TRANSPORT=smtp` with `signIn.email`, and `MAIL_TRANSPORT=none` when `signIn.email` is absent.
  - `start` requires the SMTP settings (`SMTP_URL`) only when `signIn.email` is set.
  - `start` checks that each listed provider has its secret in `OIDC_CLIENT_SECRETS` in the site's git-ignored `.env`, without printing a secret. It stops before any compose call when one is missing.
  - No secret goes into `.parallax/site.env`.
  - The operator types `OIDC_CLIENT_SECRETS` into `.env`, as `SMTP_URL` is typed today.
- **P5-23b** (`packages/create-parallax-site/templates/shared/compose.yml`) makes `OIDC_CLIENT_SECRETS` from the site's `.env` reach the `server` and `worker` processes. `compose.yml` names it by reference and holds no value. Under §9, a value in `.env` reaches a container only through such a reference.
  - The reference is `${OIDC_CLIENT_SECRETS:-}`, not `${VAR:?}`, because a site without providers has none.
  - `SMTP_URL` is referenced the same way, because a site that signs in only through providers has none.
  - `start` (P5-23a) has already stopped when a listed method's secret is missing. The secrets that `parallax env` generates stay `${VAR:?}`.
- So a level 1 or 2 site that lists providers and no email starts, and no secret value is in a template or in `site.env`.

**D11. Logs.** `redactUrl` (`apps/server/src/http/redact.ts`) also replaces the values of `code` and `state`, as it does `token`. This is built in P5-12, together with the callback route, so no request log of the callback ever holds them.

**D12. No migration (K13).**
- Accounts are keyed by the verified address, and the issuer's subject is not kept, so there is no table of provider identities.
- Pending sign-ins live in the signed cookie (D5), not in a table.
- P5-12 therefore adds no migration: `0014_p5-12_…` is not created, and P5-12 keeps its place in the chain after P5-10, whose migration is `0013_p5-10_open_class.sql`.
- P5-12, P5-13 and P5-12a, if it is added, touch neither `apps/server/drizzle/` nor `apps/server/src/db/schema/index.ts`.

### 2. How the design meets the repository's constraints

| Constraint | How |
| --- | --- |
| CSP `form-action 'self'` (`apps/server/src/app.ts`) | Provider controls are links, so a navigation goes to the start route, which redirects. No form ever posts to an issuer. |
| `SameSite=Lax` cookies on the callback | The issuer returns the browser by a top-level `GET` in the query response mode, which carries `Lax` cookies. `form_post` is never requested. `pc_session` is set on that response, as verify sets it. |
| The single e2e server, with no provider (`e2e/playwright.config.ts`) | That file is unchanged, so every existing e2e file runs against a server with no provider, as now. The A47 e2e test runs its no-provider case against that real server. For the configured cases it replaces only the one JSON answer of `GET /api/auth/methods` with `page.route`. The server side of the flow is proven in the integration tests on real PostgreSQL. |
| `publicAllowlist` (`isolation-matrix.itest.ts`) | P5-12 adds the three routes. Without them `A01 every public contract is on the reviewed allowlist` fails and names them. No other line of the file changes. |
| The `siteConfig` email rule | At least one way to sign in, at the same path (D10). |
| Exact versions (ADR-0001) | `"openid-client": "6.8.8"`, no range, in `apps/server/package.json`. ADR-0001's "Choice (exact version)" table gains, after the row "Email sign-in links", the row with concern "Sign-in providers" and choice "openid-client 6.8.8 (OpenID Connect behind `IdentityProvider`; ADR-0002, Amendment: Identity providers)". |
| `registerRoute` only, failures through it | Routes answer with `reply.redirect`, `notFound()` and `app.httpErrors.serviceUnavailable()`. There is no `reply.code(…)`, which `error-replies.test.ts` forbids. |
| Injected clock (ADR-0006) | Sessions use the injected `now`. ID token `exp` is checked by openid-client against the system clock, so the issuer fixture mints times from the real clock. |
| `infra/compose.prod.yml` stays as it is (ADR-0001, site design §9) | It is not changed. It keeps `MAIL_TRANSPORT: smtp` and passes no provider variable. See Open questions. |

### 3. ADR text

**Status line of `docs/adr/0002-authorization-and-class-isolation.md`.** Append this sentence after the last one, which ends with "see **Amendment: Open site (level 0)** at the end.":

```markdown
Amended 2026-10-14 (P5-12, owner decisions Q24 and Q25 on issue #559): signing in with a configured OpenID Connect provider reaches the account of the same verified address, a provider that asserts no verified address is refused, and a mail sender is needed for email links only; see **Amendment: Identity providers**, after **Amendment: Open site (level 0)**.
```

**New section.** Place it after **Amendment: Open site (level 0)**, at the end of the file. No other line of the file changes, and the Decision section stays as it is.

```markdown
## Amendment: Identity providers

Added 2026-10-14 (P5-12) for requirement N7, on the owner's answers Q24 and Q25 (issue #559; plan §8). This section is the first commit of P5-12's pull request, before any of its code. The Decision above is not changed: a provider sign-in ends in the same kind of session that a link sign-in starts, and the scope resolver, the 404 for non-members and the content origin apply to it unchanged. Detailed design: the plan of run R4, [docs/plans/2026-10-14-design-sign-in-with-behind-identityprovi.md](../plans/2026-10-14-design-sign-in-with-behind-identityprovi.md).

**One interface, two kinds of provider.** The email link (`EmailLinkProvider`, unchanged) and OpenID Connect (`OidcProvider`, `apps/server/src/auth/oidc-provider.ts`) both implement `IdentityProvider` (`apps/server/src/auth/identity-provider.ts`). OpenID Connect is the only provider kind built, and it is generic: a university's issuer or Google is configured by its issuer URL, a client id and a client secret. GitHub and ORCID sign-in are not built; each stays a later item for the owner. Both kinds finish through `signInWithProof`: `userForVerifiedEmail` finds or creates the account, the session the browser held is ended and a new one starts with `auth_time` set to the time of the sign-in, a deactivated account is refused like a proof that did not work, and the destination is kept only as a same-origin path (`safeDestination`, else `defaultDestination` for the entrance).

**Accounts stay keyed by a verified address.** A provider sign-in reaches the account whose `users.email` is the lower-cased address of the ID token, the key a link sign-in uses, so `INSTRUCTOR_EMAILS` and invitations, which match that address, work unchanged. The address is used only when the ID token's `email` is an address and its `email_verified` is the boolean `true`. An ID token with no address, or with `email_verified` missing, false or anything else, is refused: no account is created or changed, no session starts, and the sign-in page explains that the provider confirmed no address. The issuer's subject identifier is not stored and no table of provider identities exists: two addresses are never joined into one account, and a person whose address at the issuer changes reaches the account of the new address. A sign-in that is waiting for the issuer is held in a cookie of the browser (below), so it has no table either, and this amendment adds no migration.

**The flow.** The OpenID Connect authorization code flow with PKCE (`S256`), a `state` and a `nonce`, through `openid-client` 6.8.8, whose exact version is recorded in ADR-0001's version table. The start route keeps the state, the nonce, the code verifier, the provider id, the destination and the time of the start in the cookie `pc_oidc`: signed with `SESSION_SECRET`, HttpOnly, `SameSite=Lax`, Secure when the app is served over https, sent only to `/api/auth/oidc` and kept ten minutes. That cookie binds the sign-in to the browser that started it, and the server keeps no pending state, so a restart during a sign-in loses nothing. The issuer returns the browser with a top-level `GET` to the callback (the query response mode, never `form_post`), which carries a `Lax` cookie. The callback clears the cookie on every answer and refuses when the cookie is missing, does not verify, names another provider or was set more than ten minutes earlier, when `state` differs, or when the issuer reports an error; the issuer accepts each code once. It exchanges the code at the issuer's token endpoint with the client secret (`client_secret_basic`), outside the sign-in transaction, and checks the ID token: its signature against the keys the issuer publishes at the `jwks_uri` of its discovery document (an unsigned token and a symmetric algorithm are refused), `iss` against the configured issuer, `aud` and `azp` against the client id, `exp`, `iat` and `nonce`. The provider button on the sign-in page is a link, not a form, because the app's `form-action 'self'` would block a form whose answer redirects to the issuer. Request logs drop the values of `code` and `state` as they drop `token`.

**Routes.** Three routes are added, each registered through `registerRoute` with a contract in `packages/contracts/src/routes/auth.ts` that declares `scope: { kind: 'public' }` and `examples`, and each listed on the reviewed `publicAllowlist` of the isolation matrix: `GET /api/auth/methods` (whether email links are offered, and the id and display name of each configured provider, never its issuer, client id or secret), `GET /api/auth/oidc/:provider/start` and `GET /api/auth/oidc/:provider/callback`, the last two answering with a redirect. A provider id that is not configured answers the shared 404. Start and callback are limited per client address with the budgets of the link routes, `AUTH_LINK_RATE_LIMIT` and `AUTH_VERIFY_RATE_LIMIT`. No route reads or returns a person's records; the callback writes only through `signInWithProof`.

**Configuration; mail is optional.** `OIDC_PROVIDERS` lists the providers as JSON (`id`, display `name`, an https `issuer`, `clientId`), and `OIDC_CLIENT_SECRETS` maps each id to its client secret. Client secrets are kept only in the git-ignored environment file; a listed provider without a secret, or a secret for an id that is not listed, stops the server at start-up with a message that names the id and never the secret. A provider's button appears only when that provider is configured. A mail sender is needed for email links only: `MAIL_TRANSPORT=none` configures none, and then `GET /api/auth/methods` says that email links are not offered, the sign-in page shows no email form, and `POST /api/auth/link` answers 503, never 202, and stores no link; `none` needs at least one provider. With no provider configured and `MAIL_TRANSPORT` as today (default `file`), every existing route, contract, default and screen behaves as before, `/api/auth/link`, `/api/auth/verify`, `/api/auth/signout` and `/signin` included. A site lists its providers in `signIn.providers` of `parallax.config.ts` ([docs/design/site.md](../design/site.md) §4). A level 0 site has no sign-in, and this amendment adds none.

**Left to the owner.** This amendment decides nothing beyond N7 and the answers to Q24 and Q25. Joining accounts of different addresses, signing in without a verified address or on an issuer's own claim in place of `email_verified`, limiting a provider to some address domains, GitHub and ORCID sign-in, sign-in at level 0, and a look of its own for a provider are not built; each is a later owner decision.
```

### 4. Units of the run

Sizes are changed lines of the authored diff, `git diff --shortstat origin/main...HEAD`, counted as plan §0 counts them: lockfiles, `routeTree.gen.ts`, `drizzle/meta`, generated migrations and fixtures are left out. The landed plan is left out too, as P5-05's entry does. Each unit has a per-file breakdown. Past units of this phase came out 10 to 35 % over their estimates.

#### P5-12 · Sign-in providers, server

This is the rewritten entry. The Model value is kept as the entry has it now.

- **Scope.** Run R4, with the task: design "sign in with…" behind `IdentityProvider` with mail optional (N7; answers Q24, Q25). It covers:
  - the landed plan `docs/plans/2026-10-14-design-sign-in-with-behind-identityprovi.md`;
  - the ADR-0002 amendment **Amendment: Identity providers**, as the first commit of the pull request;
  - `OidcProvider` behind `IdentityProvider` on `openid-client` 6.8.8 (D2 to D5);
  - the public routes `GET /api/auth/methods`, `GET /api/auth/oidc/:provider/start` and `GET /api/auth/oidc/:provider/callback`, through `registerRoute`, with the callback finishing through `signInWithProof`;
  - `OIDC_PROVIDERS`, `OIDC_CLIENT_SECRETS` and `MAIL_TRANSPORT=none`, under which `POST /api/auth/link` answers 503;
  - `Deps.identityFetch`;
  - the in-process issuer of the tests.

  It also covers:
  - the exact pin of `openid-client` in ADR-0001's version table;
  - the redaction of `code` and `state` in request logs (D11), in the same pull request as the callback route.

  An assertion without a verified address is refused. No migration is added (D12). In `docs/delivery/plan.md` it writes:
  - the entries of P5-12 and P5-13;
  - the §0 sentence saying run R4 needs no table, so P5-12 adds no migration;
  - only if the measured diff passes 600: the entry of P5-12a as written below, with session 2a's row and the unit count of §9.
- **Verify.**
  - **Review.** `/security-review` by the Phase 5 reviewer.
  - **`apps/server/test/integration/a47-provider-signin.itest.ts`.** It runs on real PostgreSQL with the issuer of `apps/server/test/fixtures/oidc-issuer.ts` and no network:
    - `test('A47 signing in with a configured provider reaches the account of the same verified address')`. The setup is an account created as `ana@example.org` and a session that browser already holds; the ID token asserts `Ana@Example.ORG` with `email_verified: true`. Then:
      - the start answers 302 to the issuer's authorization endpoint, with `response_type=code`, `scope=openid email`, `code_challenge_method=S256`, a `state`, a `nonce` and `redirect_uri` `<APP_ORIGIN>/api/auth/oidc/university/callback`;
      - it sets `pc_oidc` with `HttpOnly`, `SameSite=Lax`, `Path=/api/auth/oidc` and `Max-Age=600`;
      - the callback answers 302 to the `next` given at start;
      - it sets `pc_session` (signed, HttpOnly, `SameSite=Lax`) and clears `pc_oidc`;
      - `GET /api/me` with the new cookie returns Ana's existing id, and no `users` row was added;
      - the new `auth_sessions` row has `auth_time` equal to the injected `now`, and the earlier session is revoked.
    - `test.for([...])('A47 an assertion without a verified address is refused and signs nobody in: %s')`. Five rows: no `email`, `email_verified` missing, `email_verified: false`, `email_verified: "true"`, and an `email` that is not an address. Each answers 302 to `/signin?provider=university&refused=unverified&next=%2Fcourses`, sets no `pc_session`, and adds no `users` or `auth_sessions` row.
    - `test('A47 with no mail sender no link is accepted, the methods say so, and a provider still signs people in')`, with `MAIL_TRANSPORT: 'none'`:
      - `POST /api/auth/link` answers 503 and no `signin_tokens` row exists;
      - `GET /api/auth/methods` returns `{ email: false, providers: [{ id: 'university', name: 'Example University' }] }`;
      - a provider sign-in starts a session.
    - `test('A47 the list of sign-in methods names each configured provider and no secret')`. With two providers, the answer lists both in configuration order. Its text holds no issuer, client id or client secret. With no provider configured, it is `{ email: true, providers: [] }`.
    - `test.for([...])('a callback that the browser did not start, or an ID token the issuer did not issue, is refused: %s')`. Rows:
      - signed by a key outside the issuer's set; `alg: none`; another `iss`; another `aud`; `exp` in the past; another `nonce`;
      - no `pc_oidc` cookie (a browser that did not start the flow); a `pc_oidc` cookie whose signature fails; the `state` of another start;
      - a `pc_oidc` cookie that a start at another provider set, with two providers configured;
      - a `pc_oidc` cookie from a start more than ten minutes earlier (the injected clock moved on eleven minutes);
      - a code used a second time.

      Each answers 302 with `refused=failed` and starts no session.
    - Tests with plain titles in the same file, as P5-14's entry puts a plain-titled test beside its scenario tests. They cover reused guards and logs:
      - `test('a destination that is not a same-origin path lands on the entrance default page')`. A `next` of `https://evil.example.org/x`, `//evil.example.org` or `/api/me` lands on the entrance's default page, and `/classes/x?tab=1#a` is kept.
      - `test('a deactivated account is refused like a sign-in that did not finish')`. The callback answers `refused=failed` and sets no `pc_session`.
      - `test('a provider id that is not configured answers the shared 404 at start and callback')`.
      - `test('the request log holds neither the code nor the state of a callback')`.
      - `test('an issuer that cannot be reached sends the browser back to the sign-in page and is asked again')`. With the fixture's `unreachable` switch, the start answers 302 to `/signin?provider=university&refused=failed` and sets no cookie, and the next start asks for discovery again. This is a split candidate.
      - `test('INSTRUCTOR_EMAILS and invitations work for an account reached through a provider')`. `INSTRUCTOR_EMAILS` (`' Ana@Example.org '`) lets the account reached through a provider create a course, and an instructor invitation addressed to `ana@example.org` is accepted by it. This is a split candidate.
    - Mutation checks, made locally and reverted, each make a test fail:
      - the callback's `safeDestination` replaced by the raw destination fails the destination test;
      - `redact.ts` reverted fails the log test;
      - a failed discovery cached fails the issuer test.
  - **`apps/server/src/config.test.ts`.** New cases are appended; existing cases stay unmodified.
    - Provider settings parse, with their secrets merged in.
    - `MAIL_TRANSPORT` still defaults to `file`, and `OIDC_PROVIDERS` to none.
    - `none` without a provider is refused at `MAIL_TRANSPORT`.
    - A listed provider without a secret is refused, and the message holds no secret.
    - Edge cases, a split candidate: a secret for an unlisted id, an `http` issuer, a duplicate id, an id that is not lower-case letters, digits and hyphens, an unknown key (`logo`), and invalid JSON. None of these messages holds a secret.
  - **The isolation matrix** passes with the three routes on `publicAllowlist`, and its A01 allowlist test fails when they are removed.
  - **Existing tests pass unmodified:** `auth.itest.ts`, `signin-purge.itest.ts`, `destination.test.ts`, `app.test.ts` and `error-replies.test.ts`.
  - **Diff checks.**
    - `git diff --name-only origin/main...HEAD` lists none of: `email-provider.ts`, `db/auth/sessions.ts`, `db/auth/accounts.ts`, a file under `apps/server/drizzle/`, and `apps/server/src/db/schema/index.ts`.
    - The first commit changes only `docs/adr/0002-authorization-and-class-isolation.md`.
    - `grep -c '^### P5-' docs/delivery/plan.md` prints 46, or 47 when P5-12a was split off.
    - The authored diff, counted with §0's exclusions and without the landed plan, is at most 600 changed lines.
- **Spec:** §3 (N7). ADR-0002. **Class:** complex, owns run R4. **Scenarios:** A47 (server). **Depends on:** P5-10 (migration chain). **Model:** as now. **Security:** yes. **Size:** M.
- **Touches:**
  - docs: `docs/plans/2026-10-14-design-sign-in-with-behind-identityprovi.md` (new), `docs/adr/0002-authorization-and-class-isolation.md`, `docs/adr/0001-technology-stack.md`, `docs/delivery/plan.md`;
  - dependency: `apps/server/package.json`, `pnpm-lock.yaml`;
  - server: `apps/server/src/auth/identity-provider.ts`, `apps/server/src/auth/oidc-provider.ts` (new), `apps/server/src/http/routes/auth.routes.ts`, `apps/server/src/http/redact.ts`, `apps/server/src/app.ts`, `apps/server/src/config.ts` and `config.test.ts`, `apps/server/src/mail/mailer.ts`;
  - contracts: `packages/contracts/src/routes/auth.ts`;
  - tests: `apps/server/test/fixtures/oidc-issuer.ts` (new), `apps/server/test/integration/a47-provider-signin.itest.ts` (new), `apps/server/test/integration/isolation-matrix.itest.ts` (`publicAllowlist` only);
  - `docs/delivery/done/P5-12.txt` (new: `A47`).

**Size of P5-12, about 580 changed lines**, counted with §0's exclusions:

| Part | File | Lines |
| --- | --- | --- |
| Status sentence and amendment | `docs/adr/0002-authorization-and-class-isolation.md` | 20 |
| Version row of `openid-client` | `docs/adr/0001-technology-stack.md` | 1 |
| Entries of P5-12 and P5-13; §0 sentence | `docs/delivery/plan.md` | 18 |
| Exact pin | `apps/server/package.json` | 1 |
| Type parameters, `reason` | `apps/server/src/auth/identity-provider.ts` | 12 |
| Provider: discovery cache, begin, complete, `verifiedAddress`, `PendingSignIn` with `startedAt` | `apps/server/src/auth/oidc-provider.ts` | 78 |
| `providerId`, `providerSettings`, `signInMethods`, three contracts | `packages/contracts/src/routes/auth.ts` | 52 |
| Methods, start, callback, `pc_oidc` helpers with the age check, link gate | `apps/server/src/http/routes/auth.routes.ts` | 78 |
| `code` and `state` redaction | `apps/server/src/http/redact.ts` | 2 |
| `identityFetch` | `apps/server/src/app.ts` | 3 |
| `OIDC_PROVIDERS`, `OIDC_CLIENT_SECRETS`, `none`, rules, merge | `apps/server/src/config.ts` | 40 |
| Refusing sender for `none` | `apps/server/src/mail/mailer.ts` | 6 |
| Core cases 14; edge cases 18 (split candidate) | `apps/server/src/config.test.ts` | 32 |
| Three allowlist lines and their comment | `apps/server/test/integration/isolation-matrix.itest.ts` | 4 |
| Imports 12, setup 30, A47 tests 74, refusal table 26; plain titles: destination 12, deactivated 10, unconfigured 8, log 14; split candidates: unreachable issuer 16, `INSTRUCTOR_EMAILS` and invitation 30 | `apps/server/test/integration/a47-provider-signin.itest.ts` | 232 |
| Done file | `docs/delivery/done/P5-12.txt` | 1 |

Not counted, by §0 and P5-05's entry:
- the landed plan;
- `pnpm-lock.yaml`, about 24 lines;
- the issuer fixture `apps/server/test/fixtures/oidc-issuer.ts`, with `signInThroughIssuer` and the `unreachable` switch, about 88 lines.

**If the measured diff passes 600, only test cases with plain titles split off.** Code that P5-12 needs never moves, and neither does an A47 test, a refusal row, the redaction, or the destination, deactivated-account, unconfigured-provider and log tests. The tests that move are:
1. the configuration edge cases of `config.test.ts`, about 18 lines;
2. the test of `INSTRUCTOR_EMAILS` and invitations, about 30 lines;
3. the unreachable-issuer test, about 16 lines.

Together they save about 64 lines, against about 10 plan lines for P5-12a's entry, so about 54 net. P5-12's pull request then adds P5-12a's entry as written below. If P5-12 still passes 600 after that, nothing else moves: the session asks the owner first.

#### P5-12a · Provider sign-in: guard tests with plain titles (added only if P5-12 passes 600)

This entry is prepared, not added. P5-12's pull request adds it to `docs/delivery/plan.md` §9, right after P5-12's entry, only when P5-12's measured diff passes 600. Its heading there is `### P5-12a · Provider sign-in: guard tests with plain titles`.

- **Scope.** Split off from P5-12, whose measured diff passed 600 changed lines. It holds tests with plain titles of code that P5-12 already holds, on real PostgreSQL with P5-12's in-process issuer:
  - `apps/server/test/integration/provider-signin-guards.itest.ts` (new) holds `test('an issuer that cannot be reached sends the browser back to the sign-in page and is asked again')` and `test('INSTRUCTOR_EMAILS and invitations work for an account reached through a provider')`, as P5-12's Verify describes them. Test files named for a scenario are always new, so the cases do not go into `a47-provider-signin.itest.ts`.
  - `apps/server/src/config.test.ts` gains the configuration edge cases, appended: a secret for an unlisted id, an `http` issuer, a duplicate id, an id that is not lower-case letters, digits and hyphens, an unknown key (`logo`), and invalid JSON. None of these messages holds a secret.
- **Verify.**
  - `pnpm exec vitest run --project integration provider-signin-guards` passes, and so does `pnpm exec vitest run --project unit apps/server/src/config.test.ts`.
  - With a failed discovery cached, made locally and reverted, the issuer test fails.
  - The existing cases of `config.test.ts` are unmodified. No existing test file is deleted, and none gains `.skip`, `.only` or `.todo`.
- **Spec:** §3 (N7). ADR-0002. **Class:** complex, planned by run R4. **Scenarios:** none; tests as named. **Depends on:** P5-12. **Model:** as every Phase 5 entry. **Security:** yes. **Size:** S.
- **Session:** 2a.
- **Boundary:** it depends on P5-12 (session 2), and no unit needs it, P5-13 included, so no session-2 unit depends on a session-2a item. Session 2 is running, so its list is fixed and cannot take it. Session 2a has not started and is the earliest session after P5-12. With the item, session 2a holds 6 units, and its longest chain stays three (17a → 08c → 14c).
- **Touches:** `apps/server/test/integration/provider-signin-guards.itest.ts` (new), `apps/server/src/config.test.ts`, `docs/delivery/done/P5-12a.txt` (new, empty).

**Size of P5-12a, about 90 lines:**

| Part | File | Lines |
| --- | --- | --- |
| Setup 25, unreachable issuer 16, `INSTRUCTOR_EMAILS` and invitation 30 | `apps/server/test/integration/provider-signin-guards.itest.ts` | 71 |
| Configuration edge cases | `apps/server/src/config.test.ts` | 18 |
| Done file, empty | `docs/delivery/done/P5-12a.txt` | 0 |

The plan lines that come with it are written only when the split happens, all in P5-12's pull request:
- session 2a's row of §9 lists P5-12a, adds `12a` to the chains and names its done file in the end condition;
- the count sentence of §9 reads "47 units in 7 sessions", and its list of added items ends with "and one more item, P5-12a, split off from P5-12, which P5-12 placed by the same rule".

#### P5-13 · Sign-in page and optional mail

This is the rewritten entry. The Model value is kept as the entry has it now.

- **Scope.** The sign-in page:
  - shows a link-button "Sign in with {name}" for each provider that `GET /api/auth/methods` lists;
  - shows no email form when `email` is false;
  - explains a refused provider sign-in (`?provider=…&refused=unverified|failed`);
  - with no provider configured, is unchanged.

  It also covers:
  - the `--pc-*` tokens through `Buttons.module.css` and `Page.module.css`, with no new CSS module;
  - `.env.example` with the provider variables, shown without values;
  - `.env` in the root `.gitignore`;
  - `signIn.providers` in `siteConfig`, with the rule that level 1 and above need a way to sign in;
  - `docs/design/site.md` §4, §9 and §13;
  - the provider lines of P5-23a's entry (Scope, Verify with its A47 tests, Scenarios, Depends on: P5-13) and of P5-23b's entry (Scope, Verify, Depends on: P5-13), and the A47 row of the §9 scenario table.
- **Verify.**
  - **`apps/web/src/test/signin-providers.test.tsx`** (component project; `renderApp`, `stubApi`, `expectNoAxeViolations`):
    - `it('A47 shows a button for each configured provider that starts its sign-in with the entrance and the kept destination')`. With two providers it shows exactly two links named "Sign in with Example University" and "Sign in with Example Hospital". The first has the href `/api/auth/oidc/university/start?entrance=student&next=%2Fcourses%3Fview%3Dinstructor`, and that href reads `entrance=instructor` after "Instructor sign in". The email field is still there, and axe finds no violation.
    - `it('A47 offers no email form and requests no link when no mail sender is configured')`. With `{ email: false, providers: [university] }`, there is no "Email address" field and no "Send sign-in link" button. The entrance toggle and the provider link are shown, `/signin?link=expired` shows no expired-link alert, no request reaches `/api/auth/link`, and axe finds no violation.
    - `it('A47 with no provider configured the sign-in page is the email page and ignores provider parameters')`. With `{ email: true, providers: [] }`:
      - `main` holds exactly the heading, the two entrance buttons, the email field and the send button;
      - there is no link named `/^Sign in with /`;
      - `/signin?provider=university&refused=unverified` shows no alert;
      - the markup of `main` equals the markup when the methods request answers 401, which is the page the existing sign-in tests of `shell.test.tsx` check unmodified.
    - `it('A47 explains a refused provider sign-in on the sign-in page')`. `refused=unverified` shows the alert "Example University did not confirm an email address" and, with email links offered, "You can ask for an email link below." `refused=failed` shows "Signing in with Example University did not finish". The provider link keeps `next`, and axe finds no violation.
  - **`e2e/tests/a47-signin-providers.e2e.ts`**, against the e2e server, which has no provider configured:
    - `test('A47 with no provider configured the sign-in page offers the email link and no provider button')`. `GET /api/auth/methods` answers `{ email: true, providers: [] }` and `GET /api/auth/oidc/university/start` answers 404. On `/signin?provider=university&refused=failed`, "Send sign-in link" is visible, and there is no link named `/^Sign in with /` and no alert.
    - `test('A47 a configured provider shows a button that starts its sign-in, and axe passes')`. `page.route` answers the methods request with one provider. After "Instructor sign in", clicking "Sign in with Example University" sends a navigation request to `/api/auth/oidc/university/start` with `entrance=instructor` and the `next` of the page. `AxeBuilder` finds no violation.
    - `test('A47 with no mail sender the page offers no email link, and axe passes')`.
    - `test('A47 a refused provider sign-in is explained on the sign-in page, and axe passes')`.
  - **`packages/contracts/src/site.test.ts`** gains `test('signIn.providers is a way to sign in: level 1 needs email, providers or both')`:
    - a level 1 site with providers only parses;
    - a level 1 site with neither is refused at `signIn`;
    - two providers with one id are refused at `signIn.providers`;
    - a provider with `logo` is refused.
  - **Existing tests stay green and unmodified:** `apps/web/src/test/shell.test.tsx`, `preview.test.tsx` and every existing e2e file pass. `e2e/playwright.config.ts` is unchanged, so they still run against the server with no provider.
  - **Commands:** `pnpm build && pnpm test:e2e` passes, and `pnpm check` is green.
  - **Diff checks.** `git diff --name-only origin/main...HEAD` lists:
    - no existing test file other than `site.test.ts`;
    - not `routeTree.gen.ts`, and no CSS file;
    - nothing under `apps/server/drizzle/`, and not `apps/server/src/db/schema/index.ts`.
- **Spec:** §3 (N7). ADR-0002. **Class:** complex, planned by run R4. **Scenarios:** A47 (web). **Depends on:** P5-12. **Model:** as now. **Security:** no. **Size:** M.
- **Touches:**
  - web: `apps/web/src/routes/signin.tsx` (it has no CSS module of its own and gets none: it uses the shared `apps/web/src/components/Page.module.css` and `Buttons.module.css`), `apps/web/src/test/signin-providers.test.tsx` (new);
  - e2e: `e2e/tests/a47-signin-providers.e2e.ts` (new);
  - environment: `.env.example`, `.gitignore`;
  - site configuration: `packages/contracts/src/site.ts` and `site.test.ts`, `docs/design/site.md`;
  - `docs/delivery/plan.md` (P5-23a's and P5-23b's entries, and the A47 row of the scenario table);
  - `docs/delivery/done/P5-13.txt` (new: `A47`).

**Size of P5-13, about 335 changed lines**, counted with §0's exclusions (P5-13 has no lockfile, fixture or generated file):

| Part | File | Lines |
| --- | --- | --- |
| Loader and fallback 14, search 6, refusal alert 18, provider list 14, `startHref` 6, gates 6, imports 6 | `apps/web/src/routes/signin.tsx` | 70 |
| Component test | `apps/web/src/test/signin-providers.test.tsx` | 110 |
| E2E test | `e2e/tests/a47-signin-providers.e2e.ts` | 95 |
| Provider variables without values, `none` comment | `.env.example` | 9 |
| `.env` | `.gitignore` | 1 |
| `signIn.providers`, the rule, unique ids | `packages/contracts/src/site.ts` | 12 |
| One new case | `packages/contracts/src/site.test.ts` | 16 |
| §4 row, §9 sentences, §13 row | `docs/design/site.md` | 10 |
| P5-23a's and P5-23b's entries, A47 row | `docs/delivery/plan.md` | 12 |
| Done file | `docs/delivery/done/P5-13.txt` | 1 |

**Named candidate, not added.** If P5-13 passes 600, the site configuration part becomes **P5-13a · Sign-in providers in the site configuration**. That part is `site.ts`, its test cases, `site.md` and the lines of P5-23a's and P5-23b's entries.
- **Class:** complex, planned by run R4. **Depends on:** P5-12. **Session:** 2a.
- **Boundary:** it depends on P5-12 (session 2), and P5-23a and P5-23b (session 4) need it. Session 2 is running and fixed. Session 2a is the earliest session that has not started. It would then hold 6 or 7 units, with chains of three at most.
- The `Depends on` lines of P5-23a and P5-23b would then name P5-13a.

#### Text that P5-13's pull request writes into P5-23a's and P5-23b's entries

This is the R1 handoff: `packages/cli/src/host/siteEnv.ts` does not exist yet, and P5-23a builds it.

**P5-23a · Commands on the host: env, start, apply**
- **Scope** gains: "Run R4 (P5-13): `siteEnv.ts` emits provider settings only for the providers that `signIn.providers` lists, as `OIDC_PROVIDERS` in `site.env`, which holds no secret. It writes `MAIL_TRANSPORT=smtp` when `signIn.email` is set and `MAIL_TRANSPORT=none` when it is absent. `start` requires the SMTP settings only when `signIn.email` is set. It checks that each listed provider has its secret in `OIDC_CLIENT_SECRETS` in `.env`, without printing a secret. The operator types the client secrets into `.env` as `OIDC_CLIENT_SECRETS`, as for `SMTP_URL`. No secret goes into `.parallax/site.env`."
- **Verify** gains, with the process runner injected and no Docker daemon:
  - "`packages/cli/src/host/siteEnv.test.ts`, `test('A47 a provider-only level 1 or 2 site needs no SMTP settings and emits no secret')`. For a fixture site with `signIn.providers` and no `signIn.email`, at level 1 and at level 2, `site.env` holds `MAIL_TRANSPORT=none` and exactly the listed providers in `OIDC_PROVIDERS`, and no client secret."
  - "`packages/cli/src/commands/start.test.ts`, `test('A47 start of a provider-only site asks for no SMTP_URL and stops when a listed provider has no secret')`. `start` asks for no `SMTP_URL`, stops before any compose call when a listed provider has no entry in `OIDC_CLIENT_SECRETS`, and prints no secret."
- **Scenarios** becomes: "A47 (site host); tests as named". Its done file then lists `A47`, and the A47 row of the scenario table reads "P5-12, P5-13, P5-23a".
- **Depends on** becomes: "P5-07a, P5-07b, P5-13, P5-19".

**P5-23b · Compose files of the installation**
- **Scope** gains: "Run R4 (P5-13): `compose.yml` makes `OIDC_CLIENT_SECRETS` from the site's git-ignored `.env` reach the `server` and `worker` processes, through the reference `${OIDC_CLIENT_SECRETS:-}`, and holds no value of it. `SMTP_URL` is referenced the same way. Each is needed only for a sign-in method the configuration lists, so a site without providers, or without email, has none. `start` (P5-23a) has already stopped when a listed method's secret is missing. The secrets that `env` generates stay `${VAR:?}`."
- **Verify** gains, in `apps/server/src/infra/compose-site.test.ts`: "`server` and `worker` name `OIDC_CLIENT_SECRETS` and `SMTP_URL` as `${VAR:-}` references. These are the only secrets not written `${VAR:?}`, and no file holds a value of either."
- **Depends on** becomes: "P5-13, P5-17".

### 5. The in-process issuer (`apps/server/test/fixtures/oidc-issuer.ts`)

- `ISSUER = 'https://issuer.example.test'` and a client `{ id: 'parallax-test', secret: 'fixture-secret-not-a-credential' }`. Both are fictional.
- `createIssuer()` makes two RSA keys at start with `node:crypto` `generateKeyPairSync`. It publishes the public half of the first only, with `kid: 'k1'`; the second is used for the foreign-signature row.
- It returns `{ fetch, approve, unreachable }`:
  - **`fetch`** is a `fetch`-shaped function that serves:
    - `/.well-known/openid-configuration`, with the issuer, the `authorize`, `token` and `jwks` endpoints, `response_types_supported: ['code']`, `subject_types_supported: ['public']`, `id_token_signing_alg_values_supported: ['RS256']`, `code_challenge_methods_supported: ['S256']` and `token_endpoint_auth_methods_supported: ['client_secret_basic']`;
    - `/jwks`;
    - `POST /token`. It checks Basic client authentication, a known and unused code, the `redirect_uri` and the PKCE verifier against the stored `S256` challenge, then answers `{ access_token, token_type: 'Bearer', expires_in: 300, id_token }`, or 400 `invalid_grant`.

    Any other URL throws, so the tests reach no network.
  - **`approve(authorizeUrl, grant?)`** checks `response_type`, `client_id`, the scope and `S256`. It stores a code bound to the redirect URI, the challenge, the nonce and the grant, and returns the callback URL with `code` and `state`.
  - **The ID token** has `iss`, `sub: 'subject-ana'`, `aud`, `iat`, `exp` (five minutes, on the real clock), `nonce`, `email: 'ana@example.org'` and `email_verified: true`. `grant.claims` overrides any of them, and a value of `undefined` removes the claim. `grant.key: 'stranger'` and `grant.alg: 'none'` produce the forged rows. RS256 is signed with `crypto.sign('sha256', …)`, so no extra test dependency is needed.
- `signInThroughIssuer(app, issuer, { next, entrance, grant, cookie })` runs start, approve and callback with `app.inject` and returns both responses and the session cookie. P5-12 uses it, and so does P5-12a if the split happens. The fixture is P5-12's and is not counted in its size (§0).

## Steps

**P5-12** (session 2, after P5-10 has merged).

1. **ADR first.**
   - Files: `docs/adr/0002-authorization-and-class-isolation.md`, with the status sentence and the section of Approach §3, pasted as written. This is the first commit and the only file in it.
   - Verify:
     - `git show --stat --format= $(git rev-list --reverse origin/main..HEAD | head -1)` lists only that file.
     - `git diff origin/main...HEAD -- docs/adr/0002-authorization-and-class-isolation.md | grep '^-[^-]'` prints only the old status line.
     - `grep -c 'Amendment: Identity providers' docs/adr/0002-authorization-and-class-isolation.md` prints 2.
2. **Landed plan and plan lines.**
   - Files:
     - `docs/plans/2026-10-14-design-sign-in-with-behind-identityprovi.md`, this plan as the command lands it;
     - `docs/delivery/plan.md`: the entries of P5-12 and P5-13 as in Approach §4, and the §0 sentence "Run R4 decided that provider sign-in needs no table for provider identities, so P5-12 adds no migration; it keeps its place in the chain, after P5-10". P5-12a's entry is not written here; step 12 writes it only if the split happens.
   - Verify:
     - `grep -c '^### P5-' docs/delivery/plan.md` prints 46.
     - P5-12 and P5-13 have neither `Session:` nor `Boundary:`, and session 2a still names 5 units.
     - `pnpm scenarios` passes.
3. **Dependency.**
   - Files: `apps/server/package.json` (`"openid-client": "6.8.8"`), `pnpm-lock.yaml`, and `docs/adr/0001-technology-stack.md`, whose "Choice (exact version)" table gains the row "Sign-in providers" with `openid-client` 6.8.8 (Approach §2).
   - Verify:
     - `pnpm install --frozen-lockfile` succeeds on the owner's machine.
     - `grep '"openid-client": "6.8.8"' apps/server/package.json` matches.
     - `grep -c 'openid-client 6.8.8' docs/adr/0001-technology-stack.md` prints 1.
4. **Interface.**
   - Files: `apps/server/src/auth/identity-provider.ts` (type parameters with today's defaults; `reason?: 'unverified'`; the comment names both kinds).
   - Verify: `pnpm typecheck`. `email-provider.ts` is not in the diff and still compiles as `implements IdentityProvider`.
5. **Contracts.**
   - Files: `packages/contracts/src/routes/auth.ts`, holding:
     - `providerId` and `providerSettings`;
     - `signInMethods` and `listSignInMethods`, with `examples: {}`;
     - `startProviderSignIn`, with `status: 302`, `params: { provider }`, `query: { next, entrance }` with `.catch(undefined)`, `errors: { 429 }` and `examples: { params: { provider: 'university' }, query: { next: '/courses', entrance: 'student' } }`;
     - `finishProviderSignIn`, with `status: 302`, `query: { code, state, iss, error }` as optional strings with `.catch(undefined)`, `errors: { 429 }` and `examples` with `code: 'example-code'` and `state: 'example-state'`.
   - Verify: `pnpm typecheck`. `pnpm exec vitest run --project unit apps/server/src/http/error-replies.test.ts` passes: OpenAPI lists 302, 400, 404, 429 and 503 for both redirect routes, and 200, 404 and 503 for the methods route.
6. **Configuration and mail.**
   - Files:
     - `apps/server/src/config.ts`: `OIDC_PROVIDERS` and `OIDC_CLIENT_SECRETS` parsed as JSON, in the `RUNNER_RUNTIMES` pattern; the rules of D8; `MAIL_TRANSPORT` `none`; the transform merges each secret into its provider;
     - `apps/server/src/mail/mailer.ts`: `none` returns a sender whose `send` rejects with "MAIL_TRANSPORT=none: no mail sender is configured";
     - `apps/server/src/config.test.ts`: the core cases and the edge cases, appended.
   - Verify: `pnpm exec vitest run --project unit apps/server/src/config.test.ts`. The existing cases, including `MAIL_TRANSPORT` defaulting to `file`, pass unmodified.
7. **Provider.**
   - Files: `apps/server/src/auth/oidc-provider.ts`, with `OidcProvider`, `PendingSignIn` (strict zod, with `startedAt`) and `verifiedAddress`. Details:
     - discovery is cached as a promise, which is cleared on failure;
     - `ClientSecretBasic` is used;
     - `customFetch` is set on discovery and on the configuration;
     - `enableNonRepudiationChecks` is called;
     - `begin` returns the authorization URL and the pending record;
     - `complete` checks that `pending.provider` is the provider's own id, runs `authorizationCodeGrant`, takes the claims and applies `verifiedAddress`;
     - a refusal is logged as `{ provider, reason }`, with no claim and no address.
   - Verify: step 10. The foreign-key row fails if `enableNonRepudiationChecks` is left out.
8. **Routes.**
   - Files:
     - `apps/server/src/http/routes/auth.routes.ts`:
       - a `Map` of providers built from `config.OIDC_PROVIDERS`, each with `redirectUri = new URL('/api/auth/oidc/<id>/callback', APP_ORIGIN)`;
       - the `pc_oidc` options and their reader, which refuses a record whose `startedAt` is more than ten minutes before the injected `now`;
       - `refusedAt(id, reason, destination)`;
       - the three routes of D6 and D7;
       - the link handler's guard `if (!provider || config.MAIL_TRANSPORT === 'none') throw app.httpErrors.serviceUnavailable()`. That is the one line of an existing handler that changes; verify and sign-out are untouched.
     - `apps/server/src/http/redact.ts`: `code` and `state` are redacted as `token` is (D11).
     - `apps/server/src/app.ts`: `identityFetch?: typeof fetch` in `Deps`.
   - Verify:
     - `error-replies.test.ts` passes, with no `.code(` in the route file.
     - `pnpm exec vitest run --project integration auth.itest signin-purge` passes unmodified, with `DATABASE_URL` set.
     - `app.test.ts` passes unmodified.
9. **Issuer fixture.**
   - Files: `apps/server/test/fixtures/oidc-issuer.ts`, as Approach §5 describes it.
   - Verify: `pnpm typecheck`, and its use in step 10.
10. **A47 server test.**
    - Files: `apps/server/test/integration/a47-provider-signin.itest.ts`, as in P5-12's Verify, with the A47 tests, the refusal table and the tests with plain titles.
    - Verify:
      - `pnpm exec vitest run --project integration a47-provider-signin` passes on PostgreSQL 16 at `DATABASE_URL`.
      - With the test and the fixture copied into a worktree of `origin/main`, it fails, because the start answers 404.
      - The mutation checks of P5-12's Verify each make a test fail.
11. **Isolation matrix.**
    - Files: `apps/server/test/integration/isolation-matrix.itest.ts`. Three lines go into `publicAllowlist`, `'GET /api/auth/methods'`, `'GET /api/auth/oidc/:provider/start'` and `'GET /api/auth/oidc/:provider/callback'`, with a comment that they carry no principal and return no one's data. No other line changes.
    - Verify: `pnpm exec vitest run --project integration isolation-matrix` passes, and fails with `A01 every public contract is on the reviewed allowlist` naming the routes when the three lines are removed.
12. **Close P5-12.**
    - Files: `docs/delivery/done/P5-12.txt`, holding `A47`.
    - Verify:
      - `pnpm check` is green on the owner's machine.
      - `pnpm test:integration` passes where PostgreSQL 16 is available. On the owner's machine that is the database of row P-d; the step starts no Docker daemon, and without a database the suite runs in CI only.
      - `git diff --shortstat origin/main...HEAD -- . ':(exclude)docs/plans/2026-10-14-design-sign-in-with-behind-identityprovi.md' ':(exclude)pnpm-lock.yaml' ':(exclude)apps/server/test/fixtures/oidc-issuer.ts'` is at most 600.
      - `git diff origin/main...HEAD | grep -E '^\+.*\.(skip|only|todo)\('` prints nothing.
      - The pull request goes through `/security-review` by the Phase 5 reviewer, and merges under README's rule.
    - If that count passes 600, the split of Approach §4 is made before review. Only the three test cases it names leave P5-12's diff. P5-12's pull request then adds P5-12a's entry right after P5-12's, with session 2a's row and the §9 count sentence, and `grep -c '^### P5-' docs/delivery/plan.md` prints 47. After the merge, the session creates the issue `[P5-12a]` with the labels the skill gives an added item, `security` included, and it is worked in session 2a. Without the split, none of this happens.

**P5-13** (session 2, after P5-12 has merged).

13. **The page.**
    - Files: `apps/web/src/routes/signin.tsx`. It gets:
      - `readMethods()`: a plain `fetch('/api/auth/methods', { credentials: 'same-origin' })`, parsed by `signInMethods`, with `{ email: true, providers: [] }` on any failure. A comment says why it does not use `call()`.
      - `loader: () => readMethods()`.
      - In `validateSearch`, `provider` (the id pattern) and `refused` (`'unverified' | 'failed'`).
      - `startHref(id)`.
      - The refusal alert, the three gates of D9 and the provider list.
    - Verify:
      - `pnpm exec vitest run --project component shell.test preview.test` passes unmodified.
      - `git diff --name-only` lists neither `routeTree.gen.ts` nor any `.css`.
14. **Component test.**
    - Files: `apps/web/src/test/signin-providers.test.tsx`, as in P5-13's Verify.
    - Verify: `pnpm exec vitest run --project component signin-providers` passes, and fails on `origin/main`, where no provider link exists.
15. **E2E test.**
    - Files: `e2e/tests/a47-signin-providers.e2e.ts`, as in P5-13's Verify. It uses `AxeBuilder` and needs no change to `playwright.config.ts`.
    - Verify: `pnpm build && pnpm --filter @parallax/e2e test a47-signin-providers`, then the whole `pnpm test:e2e`. Chromium build 1194 is already on the owner's machine, and the step never runs `playwright install`. Without a local PostgreSQL the suite runs in CI only.
16. **Environment files.**
    - Files:
      - `.env.example`: a comment and `OIDC_PROVIDERS=` with the shape `[{"id","name","issuer","clientId"}]`, the redirect URI to register (`<APP_ORIGIN>/api/auth/oidc/<id>/callback`) and an example issuer `https://login.example.org`; `OIDC_CLIENT_SECRETS=` with the shape `{"<id>":"<secret>"}`, both without values; and the `MAIL_TRANSPORT` comment naming `none` (no email link; needs a provider);
      - `.gitignore`: `.env`.
    - Verify:
      - `grep -E '^OIDC_(PROVIDERS|CLIENT_SECRETS)=$' .env.example` prints two lines.
      - `git check-ignore .env` prints `.env`.
17. **Site configuration (K24).**
    - Files:
      - `packages/contracts/src/site.ts`: `signIn.providers`; the rule "level 1 and above need a way to sign in: signIn.email, signIn.providers or both"; unique ids;
      - `packages/contracts/src/site.test.ts`: the new test;
      - `docs/design/site.md`: §4's `signIn` row; §9's sentences on `site.env`, `.env`, `start` and the `${OIDC_CLIENT_SECRETS:-}` and `${SMTP_URL:-}` references of `compose.yml` (D10); and §13's R4 row saying it landed with P5-12 and P5-13;
      - `docs/delivery/plan.md`: P5-23a's and P5-23b's entries and the A47 row of the scenario table, as Approach §4 gives them.
    - Verify:
      - `pnpm exec vitest run --project unit packages/contracts/src/site.test.ts` passes. The existing refusal case `['signIn', one({ signIn: {} })]` passes unmodified.
      - P5-23a's entry names `siteEnv.ts`, its two A47 test titles and P5-13 in `Depends on`, and P5-23b's entry names `OIDC_CLIENT_SECRETS` in `compose.yml` and P5-13 in `Depends on`.
18. **Close P5-13.**
    - Files: `docs/delivery/done/P5-13.txt`, holding `A47`.
    - Verify:
      - `pnpm check` is green, and `pnpm scenarios` passes.
      - The diff checks of P5-13's Verify hold, and the diff is at most 600, else P5-13a as named.
      - The pull request is reviewed by the Phase 5 reviewer and merged under README's rule.

**P5-12a** (session 2a, only if step 12 split it off).

19. **Guard tests with plain titles.**
    - Files: as P5-12a's Touches. The fixture's `unreachable` switch is already in P5-12, so P5-12a changes no fixture and no code.
    - Verify: as P5-12a's Verify. The pull request goes through `/security-review`, and its done file `docs/delivery/done/P5-12a.txt` is empty.

## Risks

- **Account takeover through an issuer that vouches for addresses it does not control.** This is the risk of the run.
  - Mitigations:
    - only the operator configures issuers;
    - `email_verified` must be the boolean `true`;
    - the account key is the address, as it is for links.
  - An issuer whose tenants can set any address, and which still claims it verified, would let a stranger in. P5-24's guide must say to configure only issuers that verify addresses.
  - Microsoft's multi-tenant endpoint, which sends no `email_verified`, is refused by this rule.
- **ID token signatures are not checked by default.** openid-client skips the JWS check of a token-endpoint ID token unless `enableNonRepudiationChecks` is called. The foreign-key row of P5-12's refusal table fails if the call is missing.
- **Issuer identifier matching is exact.** Discovery refuses a document whose `issuer` differs from the configured one, for example by a trailing slash. Start then lands on `refused=failed`. P5-24 documents that the configured value is the issuer as it publishes itself. The fixture uses the form a real issuer publishes, so the implementer finds any library nuance in step 10.
- **Algorithms.** RS256 is the client's expected algorithm. An issuer that signs ID tokens only with ES256 or PS256 cannot be configured. A setting for it would be a later item.
- **ID token from the token endpoint only.** An issuer that releases `email` only at its UserInfo endpoint is refused as `unverified`. Calling UserInfo would be a later item.
- **A future form would break silently.** If a later change turns the provider link into a form, browsers block the redirect under `form-action 'self'`. The e2e test waits for a navigation request to the start route, and the plan states the reason in the component's comment.
- **Size.** P5-12 is estimated at about 580 counted lines, close to the limit, and units of this phase have run 10 to 35 % over. If its measured diff passes 600, the three plain-titled test cases of §4 move to P5-12a, which saves about 54 lines net. Code, the A47 tests, the refusal rows, the redaction and the destination and deactivated-account tests never move. If P5-12 still passes 600 after the split, the session asks the owner before anything else moves.
- **Server restart during a sign-in.** Nothing is lost. The pending record is in the browser's signed cookie, and the server keeps none. The callback after a restart verifies it with the same `SESSION_SECRET` and finishes. Only a changed `SESSION_SECRET` refuses it (`refused=failed`), and the person starts again.
- **Interim state in session 2.** Between the merges of P5-12 and P5-13, the provider routes work but the page shows no button and ignores `refused`. Nothing is published in that window. Request logs never hold `code` or `state`, because the redaction lands with the callback route.
- **Fallback page on a no-mail server.** If `/api/auth/methods` cannot be read, the page falls back to today's email form. On a `none` server, a submission then answers 503 with today's error line. This happens only when the server does not answer at all.
- **First use of `page.route` in this e2e suite.** It replaces one JSON answer only. A reviewer may prefer a second e2e server, but that would change `playwright.config.ts` and the run of every existing e2e file (K20).
- **Clock.** ID token times are checked on the system clock, not the injected one. The fixture mints from `Date.now()`, so the tests do not depend on the injected date.
- **Windows.** The integration and e2e suites need PostgreSQL 16. Where the owner's machine has none running, they run in CI only (row P-d), and no step starts a Docker daemon.
- **The from-source deployment.** `infra/compose.prod.yml` keeps `MAIL_TRANSPORT: smtp` and passes no provider variable, because its test pins its variables and both designs keep it as it is. Providers are available to a site's installation (P5-23a) and to any deployment that sets the variables.

## Open questions

These are for the owner. None is decided here, and none blocks a unit.

1. **Joining accounts of different addresses**, for example a person's university and Google addresses. Not built.
2. **Signing in without a verified address**, or trusting an issuer's own claim in place of `email_verified`, such as Microsoft Entra's. Refused today.
3. **GitHub and ORCID sign-in.** Later items by Q24.
4. **Limiting a provider to address domains**, for example only the university's domain. Not built. Today a configured Google provider admits every Google account with a confirmed address, as the email link admits every mailbox; neither gives a role.
5. **Whether sensitive membership changes should force a fresh login at the issuer** (`max_age=0` or `prompt=login`). Today a provider sign-in sets `auth_time` to the time of the callback, so the issuer's single sign-on counts as a fresh sign-in, as a click on a mailed link does.
6. **A look of its own for a provider** (logo, colour). Not built: Q10 keeps the look fixed, and `providerSettings` has no field for it.
7. **Signing out at the issuer** (RP-initiated logout). Today sign-out ends the Parallax session only.
8. **Provider settings in `infra/compose.prod.yml`, the from-source deployment.** They would be a new added item, because its test pins its variables.

Sign-in at level 0 is not open. N7 says a level 0 site has no sign-in, and nothing here adds one.

_Hybrid by /collab-independent-plan --judge jev after 1 round(s)._
