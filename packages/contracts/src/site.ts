import { z } from 'zod';
import { providerSettings } from './routes/auth';
import { RunnerRuntimeId } from './runner';

// docs/design/site.md: `parallax.config.ts` (§4), `instructor.yaml` (§7), the catalogue (§6.6).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const NO_CONTROL = /^\P{Cc}*$/u;
/** A folder's name as a directory listing gives it; one that starts with a dot is none. */
const FOLDER = /^(?!\.)[^/\\\p{Cc}]{1,255}$/u;
const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL, 'holds a control character');
/** Host names are compared without a trailing dot; `URL` has lower-cased them. */
const hostOf = (origin: string) => new URL(origin).hostname.replace(/\.$/, '');

/** An origin as the server's settings take it: https, or http on a loopback host. */
const origin = z.string().transform((value, ctx) => {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  const local = url?.protocol === 'http:' && LOOPBACK.has(url.hostname);
  const bare = url?.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (url && bare && (url.protocol === 'https:' || local)) return url.origin;
  ctx.addIssue({ code: 'custom', message: 'an origin: https, or http on a loopback host' });
  return z.NEVER;
});

/** A sandbox runtime as the server's `RUNNER_RUNTIMES` has it; here the digest is required. */
const runtime = z.strictObject({
  id: RunnerRuntimeId,
  language: z.enum(['python', 'r']),
  image: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'sha256: and 64 hex digits'),
  harnessVersion: z.string().regex(/^[0-9]+$/),
  packages: z.array(z.string().min(1)),
});
const logoFile = z.string().regex(/\.(png|jpe?g|webp)$/i, 'a PNG, JPEG or WebP file');
const classEntry = z.strictObject({
  course: z.string(),
  name: text(80),
  open: z.boolean().default(false),
  instructors: z.array(z.string()).min(1).optional(),
});
const fields = z.strictObject({
  mode: z.enum(['instructor', 'school']),
  name: text(80),
  logo: z.strictObject({ file: logoFile, alt: text(120) }).optional(),
  level: z.literal([0, 1, 2]),
  origins: z.strictObject({ app: origin, content: origin, shiny: z.array(origin).default([]) }),
  signIn: z
    .strictObject({
      email: z.strictObject({ from: text(200) }).optional(),
      // The server's `OIDC_PROVIDERS` entries; the client secrets are typed into `.env` (§9).
      providers: z.array(providerSettings).optional(),
    })
    .optional(),
  instructors: z.array(z.string()).min(1).optional(),
  classes: z.array(classEntry).default([]),
  runner: z
    .strictObject({ host: z.ipv4(), databaseHost: z.ipv4(), runtimes: z.array(runtime).min(1) })
    .optional(),
});

/** The rules that span fields. They run once every field has its type. */
function rules(config: z.output<typeof fields>, ctx: z.RefinementCtx): void {
  const refuse = (message: string, ...path: PropertyKey[]) =>
    ctx.addIssue({ code: 'custom', path, message });
  const { level, origins, classes, runner } = config;
  const school = config.mode === 'school';
  const app = hostOf(origins.app);
  const shared = app === hostOf(origins.content);
  if (shared) refuse(`must not have the host name of origins.app, ${app}`, 'origins', 'content');
  // Cookies ignore ports, so the app's host on any port is refused, as the server refuses it.
  origins.shiny.forEach((shiny, i) => {
    const own = shiny === origins.content || hostOf(shiny) === app;
    if (own) refuse('is the content origin or on the host of origins.app', 'origins', 'shiny', i);
  });
  const { email, providers = [] } = config.signIn ?? {};
  const way = 'level 1 and above need a way to sign in: signIn.email, signIn.providers or both';
  if (level >= 1 && !email && providers.length === 0) refuse(way, 'signIn');
  const providerIds = providers.map((provider) => provider.id);
  const twice = new Set(providerIds).size < providerIds.length;
  if (twice) refuse('provider ids must be unique', 'signIn', 'providers');
  if (level === 2 && !runner) refuse('required at level 2', 'runner');
  const ids = runner?.runtimes.map((entry) => entry.id) ?? [];
  if (new Set(ids).size < ids.length) refuse('runtime ids must be unique', 'runner', 'runtimes');

  const given = config.instructors;
  const listed = school ? (given ?? []) : ['.'];
  const unlisted = (ref: string) => `${ref} is not in instructors`;
  if (school && !given) refuse('school mode names the folders under instructors/', 'instructors');
  const other = !school && given && given.join() !== '.';
  if (other) refuse("instructor mode has one instructor folder, '.'", 'instructors');
  (school ? listed : []).forEach((ref, i) => {
    if (ref.includes('@')) refuse('a folder name, never an address', 'instructors', i);
    else if (!FOLDER.test(ref)) refuse('the name of a folder under instructors/', 'instructors', i);
    else if (listed.indexOf(ref) < i) refuse('listed twice', 'instructors', i);
  });
  classes.forEach((cls, i) => {
    const parts = cls.course.split('/');
    const holder = school ? (parts[0] ?? '') : '.';
    const form = school ? '<instructor folder>/<course folder>' : 'a folder in courses/';
    const formed = parts.length === (school ? 2 : 1) && parts.every((part) => FOLDER.test(part));
    if (!formed) refuse(`a course is written as ${form}`, 'classes', i, 'course');
    else if (!listed.includes(holder)) refuse(unlisted(holder), 'classes', i, 'course');
    const twin = classes.findIndex((o) => o.course === cls.course && o.name === cls.name) < i;
    if (twin) refuse(`a second class of ${cls.course} with this name`, 'classes', i, 'name');
    cls.instructors?.forEach((ref, j) => {
      if (!listed.includes(ref)) refuse(unlisted(ref), 'classes', i, 'instructors', j);
    });
  });
}

export const siteConfig = fields.superRefine(rules).transform((config) => ({
  ...config,
  instructors: config.instructors ?? ['.'],
  classes: config.classes.map((cls) => {
    // A class that names no instructor has the folder that holds its course.
    const holder = config.mode === 'school' ? (cls.course.split('/')[0] ?? '.') : '.';
    return { ...cls, instructors: cls.instructors ?? [holder] };
  }),
}));
export type SiteConfig = z.output<typeof siteConfig>;
/** What `parallax.config.ts` writes; a field with a default may be left out. */
export type SiteConfigInput = z.input<typeof siteConfig>;

/** The content of `instructor.yaml`. The address decides who owns the folder's courses (§7). */
export const instructorMeta = z.strictObject({ name: text(120), email: z.email().max(254) });
export type InstructorMeta = z.output<typeof instructorMeta>;

const slug = z.string().regex(FOLDER);
/**
 * What a site page gets at build time (§6.6): display names and course titles, each with its
 * folder's name. It has no field for an address, a topic, a resource or a definition.
 */
export const siteCatalogue = z.strictObject({
  instructors: z.array(
    z.strictObject({
      slug,
      name: text(120),
      courses: z.array(z.strictObject({ slug, title: text(255) })),
    }),
  ),
});
export type SiteCatalogue = z.output<typeof siteCatalogue>;

/** One line for each issue of a failed parse, starting with its field: `classes[1].course: …`. */
export function siteIssueLines(issues: z.core.$ZodIssue[]): string[] {
  const at = (path: PropertyKey[]) =>
    path.map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i ? '.' : ''}${String(key)}`));
  return issues.flatMap((issue) => {
    if (issue.code !== 'unrecognized_keys') {
      const field = at(issue.path).join('');
      return [field ? `${field}: ${issue.message}` : issue.message];
    }
    return issue.keys.map((key) => `${at([...issue.path, key]).join('')}: unknown key`);
  });
}
