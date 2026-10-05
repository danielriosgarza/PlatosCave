import { z } from 'zod';
import { LinkAuth, LinkHost, LinkLease, LinkPath, LinkRuntime, LinkUser } from '../connector';
import { classArchived, defineRoute } from '../define';
import { exampleIds } from '../examples';
import type { ConnectionTarget } from './connections';

/**
 * Class host templates (docs/design/connector.md §11; spec §10.3, §13). An instructor publishes
 * a host, runtime and isolation for a class, with the statement that the host owner permits
 * this use; every member reads them. A template carries no user, key, token or home directory:
 * a learner makes their own connection from it with their own account and credential reference
 * (`POST /api/me/connections` with `templateId`). Writes need a recent sign-in (401
 * `recent_auth_required`); writes to an archived class answer 409 `class_archived`.
 */

const datetime = z.iso.datetime({ offset: true });
const Port = z.number().int().min(1).max(65535);
const classParams = z.object({ classId: z.uuid() });
const templateParams = classParams.extend({ templateId: z.uuid() });

/** What stands for the learner's own account name in a workspace pattern. */
export const USER_PLACEHOLDER = '{user}';

/**
 * Where a template's connections go: host, port, an optional jump host and a workspace pattern
 * in which `{user}` is the learner's account name. No field exists for a user or a credential.
 */
export const TemplateTarget = z.strictObject({
  host: LinkHost,
  port: Port,
  jump: z.strictObject({ host: LinkHost, port: Port }).optional(),
  workspace: LinkPath,
});
export type TemplateTarget = z.infer<typeof TemplateTarget>;

/** A template starts Jupyter for each learner; attaching names one person's running server. */
export const TemplateRuntime = LinkRuntime.options[0];
export type TemplateRuntime = z.infer<typeof TemplateRuntime>;

/**
 * How the host keeps learners apart (spec §10.3): an OS account per learner, a container per
 * learner, or a session issued by the host's allocation service.
 */
export const TemplateIsolation = z.enum(['account', 'container', 'allocation']);
export type TemplateIsolation = z.infer<typeof TemplateIsolation>;

/**
 * The learner's own part of a connection made from a template: their account name, the
 * credential reference on their connector's computer (a key path, or an agent identity named by
 * `hint` so the template's host never sees every key in the agent, design §5.3), and the account
 * on the jump host when it differs.
 */
export const TemplateAccount = z.strictObject({
  user: LinkUser,
  auth: z.discriminatedUnion('method', [
    LinkAuth.options[0],
    z.strictObject({ method: z.literal('agent'), hint: z.string().min(1).max(128) }),
  ]),
  jumpUser: LinkUser.optional(),
});
export type TemplateAccount = z.infer<typeof TemplateAccount>;

/**
 * The target a learner's connection from `template` holds: the template's host, port and jump
 * host, the learner's account and credential reference on both hops, and the workspace pattern
 * with `{user}` replaced by the learner's account name. The server accepts a connection naming a
 * template only when its target is exactly this.
 */
export function targetFromTemplate(
  template: TemplateTarget,
  account: TemplateAccount,
): Extract<ConnectionTarget, { kind: 'ssh' }> {
  return {
    kind: 'ssh',
    host: template.host,
    port: template.port,
    user: account.user,
    auth: account.auth,
    workspace: template.workspace.split(USER_PLACEHOLDER).join(account.user),
    ...(template.jump && {
      jump: {
        host: template.jump.host,
        port: template.jump.port,
        user: account.jumpUser ?? account.user,
        auth: account.auth,
      },
    }),
  };
}

/** The learner's part of a template connection's target, if it has the shape one has. */
export function accountOf(target: ConnectionTarget): TemplateAccount | null {
  if (target.kind !== 'ssh') return null;
  const parsed = TemplateAccount.safeParse({
    user: target.user,
    auth: target.auth,
    ...(target.jump && target.jump.user !== target.user && { jumpUser: target.jump.user }),
  });
  return parsed.success ? parsed.data : null;
}

export const ComputeTemplateView = z.object({
  id: z.uuid(),
  classId: z.uuid(),
  name: z.string(),
  description: z.string(),
  target: TemplateTarget,
  runtime: TemplateRuntime,
  isolation: TemplateIsolation,
  /** The lease a session from this template starts with; null for the default (design §9). */
  lease: LinkLease.nullable(),
  hostOwnerConfirmedAt: datetime,
  createdAt: datetime,
  archivedAt: datetime.nullable(),
});
export type ComputeTemplateView = z.infer<typeof ComputeTemplateView>;

const TemplateName = z.string().trim().min(1).max(80);
const TemplateDescription = z.string().trim().max(1000);
/** The instructor's statement that the host owner permits this use; required on every write. */
const HostOwnerConfirmed = z.literal(true);

/**
 * 400 for a template whose connections Parallax would refuse: `invalid_target` breaks a rule of
 * design §4.4 for every learner (`rules` names them), `workspace_needs_user` is a workspace
 * pattern without `{user}` on a host isolated by OS account, where it would name one directory
 * for every learner.
 */
export const templateRefused = z.object({
  error: z.literal('target_not_allowed'),
  code: z.enum(['invalid_target', 'workspace_needs_user']),
  rules: z.array(z.number().int()).optional(),
});

const exampleTemplate = {
  name: 'Department cluster',
  description: 'Each student signs in with their own university account.',
  target: { host: 'jupyter.cluster.example.org', port: 22, workspace: '/home/{user}/parallax' },
  runtime: { mode: 'start' as const, kernelName: 'python3' },
  isolation: 'account' as const,
  hostOwnerConfirmed: true as const,
};

/** The class's unarchived templates, oldest first. Every member reads them. */
export const listComputeTemplates = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/compute-templates',
  scope: { kind: 'class', role: 'any' },
  summary: "List the class's compute templates",
  params: classParams,
  response: z.array(ComputeTemplateView),
  examples: { params: { classId: exampleIds.zero } },
});

/** Publishes a template; audited as `template.published`. */
export const createComputeTemplate = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/compute-templates',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Publish a compute template for the class',
  status: 201,
  params: classParams,
  body: z.strictObject({
    name: TemplateName,
    description: TemplateDescription.default(''),
    target: TemplateTarget,
    runtime: TemplateRuntime,
    isolation: TemplateIsolation,
    lease: LinkLease.nullable().optional(),
    hostOwnerConfirmed: HostOwnerConfirmed,
  }),
  response: ComputeTemplateView,
  errors: { 400: templateRefused, 409: classArchived },
  examples: { params: { classId: exampleIds.zero }, body: exampleTemplate },
});

/**
 * Changes a template's name, description, isolation or lease, with the host-owner statement
 * again. Its host, jump host, workspace and runtime are fixed: connections made from it hold
 * them, so another host is a new template (archive this one).
 */
export const updateComputeTemplate = defineRoute({
  method: 'PATCH',
  path: '/api/classes/:classId/compute-templates/:templateId',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Change a compute template',
  params: templateParams,
  body: z.strictObject({
    name: TemplateName.optional(),
    description: TemplateDescription.optional(),
    isolation: TemplateIsolation.optional(),
    lease: LinkLease.nullable().optional(),
    hostOwnerConfirmed: HostOwnerConfirmed,
  }),
  response: ComputeTemplateView,
  errors: { 409: classArchived },
  examples: {
    params: { classId: exampleIds.zero, templateId: exampleIds.aa },
    body: { name: 'Department cluster (GPU)', hostOwnerConfirmed: true },
  },
});

/**
 * Archives a template; audited as `template.archived`. No new connection can be made from it,
 * and a session cannot be opened on a connection made from it (409 `template_archived`).
 */
export const archiveComputeTemplate = defineRoute({
  method: 'DELETE',
  path: '/api/classes/:classId/compute-templates/:templateId',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Archive a compute template',
  params: templateParams,
  response: ComputeTemplateView,
  errors: { 409: classArchived },
  examples: { params: { classId: exampleIds.zero, templateId: exampleIds.aa } },
});
