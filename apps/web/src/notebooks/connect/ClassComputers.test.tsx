import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { CLASS_A, stubApi } from '../../test/render';
import type { ComputeTemplate } from './api';
import { ISOLATION_TEXT, PERSONAL_STATEMENT, TemplateConnectForm } from './ClassComputers';
import { ConnectPanel } from './ConnectPanel';
import {
  CONNECTION,
  CONNECTOR,
  connector,
  ok,
  REVISION,
  sshConnection,
  TEST_ID,
  testView,
} from './fixtures';
import { TemplateManager } from './TemplateManager';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEMPLATE = '00000000-0000-4000-8000-0000000f0001';
const TEMPLATE_B = '00000000-0000-4000-8000-0000000f0002';

const template = (over: Partial<ComputeTemplate> = {}): ComputeTemplate => ({
  id: TEMPLATE,
  classId: CLASS_A,
  name: 'Department cluster',
  description: 'Use your university account.',
  target: {
    host: 'jupyter.cluster.example.org',
    port: 22,
    jump: { host: 'gateway.example.org', port: 2222 },
    workspace: '/home/{user}/parallax',
  },
  runtime: { mode: 'start', kernelName: 'python3' },
  isolation: 'account',
  lease: { idleTimeoutMin: 90, gracePeriodMin: 15 },
  hostOwnerConfirmedAt: '2026-10-04T09:00:00Z',
  createdAt: '2026-10-04T09:00:00Z',
  archivedAt: null,
  ...over,
});

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>{node}</QueryClientProvider>,
  );

describe('Class computers for a learner', () => {
  it('A33 a connection from a template holds only the learner’s own account and key', async () => {
    const onSubmit = vi.fn();
    wrap(
      <TemplateConnectForm
        templates={[template()]}
        connectors={[connector()]}
        busy={false}
        onSubmit={onSubmit}
      />,
    );
    // The template's host and directory are fixed; the learner types only what is theirs.
    expect(screen.queryByLabelText('Host')).toBeNull();
    expect(screen.queryByLabelText('Working directory')).toBeNull();
    await userEvent.type(screen.getByLabelText(/Your account on jupyter/), 'sam.okafor');
    expect(screen.getByText('/home/sam.okafor/parallax')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/One key from the SSH agent/));
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    // An agent key must be named, so the template's host is not offered every key in the agent.
    expect(screen.getByRole('alert')).toHaveTextContent('comment or fingerprint');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Agent key comment or fingerprint'), 'sam@laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    const auth = { method: 'agent', hint: 'sam@laptop' };
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Department cluster',
      connectorId: CONNECTOR,
      templateId: TEMPLATE,
      target: {
        kind: 'ssh',
        host: 'jupyter.cluster.example.org',
        port: 22,
        user: 'sam.okafor',
        auth,
        workspace: '/home/sam.okafor/parallax',
        jump: { host: 'gateway.example.org', port: 2222, user: 'sam.okafor', auth },
      },
      runtime: { mode: 'start', kernelName: 'python3' },
    });
  });

  it('states each isolation in plain words, with the personal-connection statement', async () => {
    for (const isolation of ['account', 'container', 'allocation'] as const) {
      const view = wrap(
        <TemplateConnectForm
          templates={[template({ isolation })]}
          connectors={[connector()]}
          busy={false}
          onSubmit={vi.fn()}
        />,
      );
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent(ISOLATION_TEXT[isolation]);
      expect(note).toHaveTextContent(PERSONAL_STATEMENT);
      view.unmount();
    }
    expect(ISOLATION_TEXT.account).toMatch(/own account/);
    expect(ISOLATION_TEXT.container).toMatch(/own container/);
    expect(ISOLATION_TEXT.allocation).toMatch(/allocation service/);
  });

  it('the learner form is usable from the keyboard alone', async () => {
    const onSubmit = vi.fn();
    const { container } = wrap(
      <TemplateConnectForm
        templates={[template(), template({ id: TEMPLATE_B, name: 'GPU nodes' })]}
        connectors={[connector()]}
        busy={false}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: /Department cluster/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /GPU nodes/ })).toBeChecked();
    await userEvent.tab();
    expect(screen.getByLabelText('Connection name')).toHaveValue('GPU nodes');
    expect(screen.getByLabelText('Connection name')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Computer running the connector')).toHaveFocus();
    await userEvent.tab();
    await userEvent.keyboard('sam');
    await userEvent.tab();
    expect(screen.getByLabelText(/Your account on gateway/)).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: /Key file/ })).toHaveFocus();
    await userEvent.tab();
    await userEvent.keyboard('~/.ssh/id_ed25519');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Save and test connection' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: TEMPLATE_B, name: 'GPU nodes' }),
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

/** A templates API for the instructor's list and form. */
function serveTemplates(state: {
  templates: ComputeTemplate[];
  posts: { url: string; method: string; body: unknown }[];
  refuse?: { status: number; body: unknown };
}) {
  const path = `/api/classes/${CLASS_A}/compute-templates`;
  return stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') state.posts.push({ url, method, body });
    if (url === path && method === 'GET') return { status: 200, body: state.templates };
    if (state.refuse) return state.refuse;
    if (url === path && method === 'POST') {
      const made = template({ ...body, id: TEMPLATE_B });
      state.templates = [...state.templates, made];
      return { status: 201, body: made };
    }
    if (url === `${path}/${TEMPLATE}` && method === 'DELETE') {
      state.templates = state.templates.filter((t) => t.id !== TEMPLATE);
      return { status: 200, body: template({ archivedAt: '2026-10-05T09:00:00Z' }) };
    }
    return { status: 404, body: {} };
  });
}

async function fillTemplate() {
  await userEvent.click(screen.getByRole('button', { name: 'Publish a class computer' }));
  const form = screen.getByRole('form', { name: 'Publish a class computer' });
  await userEvent.type(within(form).getByLabelText('Name'), 'Teaching servers');
  await userEvent.type(within(form).getByLabelText('Host'), 'jupyter.teaching.example.org');
  return form;
}

describe('Class computers for an instructor', () => {
  it('publishes nothing until the host owner’s permission is confirmed', async () => {
    const state = { templates: [template()], posts: [] as never[] };
    serveTemplates(state);
    wrap(<TemplateManager classId={CLASS_A} />);
    expect(await screen.findByText('Department cluster')).toBeInTheDocument();
    expect(screen.getByText(ISOLATION_TEXT.account)).toBeInTheDocument();
    expect(screen.getByText(/You cannot see or use their connections/)).toBeInTheDocument();
    const form = await fillTemplate();
    await userEvent.click(within(form).getByLabelText(/gets their own container/));
    await userEvent.click(within(form).getByRole('button', { name: 'Publish' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Confirm that the owner of this computer permits this class to use it.',
    );
    expect(state.posts).toEqual([]);
    await userEvent.click(within(form).getByLabelText(/owner of this computer permits/));
    await userEvent.click(within(form).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    // The form has no field for an account, key or token: the body carries none.
    expect(state.posts[0]).toEqual({
      url: `/api/classes/${CLASS_A}/compute-templates`,
      method: 'POST',
      body: {
        name: 'Teaching servers',
        description: '',
        target: {
          host: 'jupyter.teaching.example.org',
          port: 22,
          workspace: '/home/{user}/parallax',
        },
        runtime: { mode: 'start' },
        isolation: 'container',
        lease: null,
        hostOwnerConfirmed: true,
      },
    });
    expect(await screen.findByText('Teaching servers')).toBeInTheDocument();
  });

  it('says when a recent sign-in is needed, and archives only after confirming', async () => {
    const state = {
      templates: [template()],
      posts: [] as { url: string; method: string; body: unknown }[],
      refuse: { status: 401, body: { error: 'unauthorized', code: 'recent_auth_required' } },
    };
    serveTemplates(state);
    wrap(<TemplateManager classId={CLASS_A} />);
    await screen.findByText('Department cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Archive Department cluster' }));
    expect(state.posts).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a recent sign-in');
    state.refuse = undefined as never;
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByText('Department cluster')).toBeNull());
    expect(state.posts.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('Escape in the archive confirmation cancels it, returns focus and leaves the panel open', async () => {
    const state = { templates: [template()], posts: [] as never[] };
    serveTemplates(state);
    const closed = vi.fn();
    wrap(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the panel's Escape handler
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) closed();
        }}
      >
        <TemplateManager classId={CLASS_A} />
      </div>,
    );
    await screen.findByText('Department cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Archive Department cluster' }));
    screen.getByRole('button', { name: 'Keep it' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive Department cluster' })).toHaveFocus();
    expect(state.posts).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('the publish form is usable from the keyboard alone', async () => {
    const state = { templates: [], posts: [] as { body: unknown }[] };
    serveTemplates(state as never);
    wrap(<TemplateManager classId={CLASS_A} />);
    await screen.findByText('No class computers yet.');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Publish a class computer' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await userEvent.keyboard('Lab');
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('lab.example.org');
    const confirm = screen.getByLabelText(/owner of this computer permits/);
    while (document.activeElement !== confirm) await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(confirm).toBeChecked();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(state.posts[0]?.body).toMatchObject({
        name: 'Lab',
        target: { host: 'lab.example.org' },
        hostOwnerConfirmed: true,
      }),
    );
  });
});

describe('Class computers in the Connect panel', () => {
  it('connects through a class computer with the template’s lease and isolation shown', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const ready = testView({
      outcome: 'ready_to_start',
      kernelspecs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }],
      stages: [ok('workspace', { resolvedPath: '/home/sam/parallax' })],
    });
    stubApi((url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'POST') posts.push({ url, body });
      if (url === '/api/me/connectors') return { status: 200, body: [connector()] };
      if (url === '/api/me/connections' && method === 'GET') return { status: 200, body: [] };
      if (url === '/api/me/connections' && method === 'POST') {
        return { status: 201, body: sshConnection({ ...body, id: CONNECTION }) };
      }
      if (url === `/api/classes/${CLASS_A}/compute-templates`) {
        return { status: 200, body: [template()] };
      }
      if (url === `/api/classes/${CLASS_A}/notebook-sessions`) return { status: 200, body: [] };
      if (url === `/api/me/connections/${CONNECTION}/test`) {
        return { status: 202, body: { testId: TEST_ID } };
      }
      if (url === `/api/me/connections/${CONNECTION}/tests/${TEST_ID}`) {
        return { status: 200, body: ready };
      }
      return { status: 404, body: {} };
    });
    wrap(<ConnectPanel classId={CLASS_A} revisionId={REVISION} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Class computers' }));
    await userEvent.type(screen.getByLabelText(/Your account on jupyter/), 'sam');
    await userEvent.type(screen.getByLabelText('Key file path'), '~/.ssh/id_ed25519');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    await waitFor(() => expect(posts[0]?.url).toBe('/api/me/connections'));
    expect(posts[0]?.body).toMatchObject({
      templateId: TEMPLATE,
      target: { user: 'sam', workspace: '/home/sam/parallax' },
    });
    // The template's lease is the default, and the summary says how students are kept apart.
    expect(await screen.findByLabelText(/Stop after minutes/)).toHaveValue('90');
    expect(screen.getByLabelText(/Keep the kernel after closing/)).toHaveValue('15');
    expect(screen.getByText(`Department cluster. ${ISOLATION_TEXT.account}`)).toBeInTheDocument();
    // Students see no instructor controls.
    expect(screen.queryByRole('button', { name: 'Publish a class computer' })).toBeNull();
  });

  it('offers instructors the class computers they publish', async () => {
    stubApi((url) => {
      if (url === `/api/classes/${CLASS_A}/compute-templates`) {
        return { status: 200, body: [template()] };
      }
      if (url === '/api/me/connectors') return { status: 200, body: [connector()] };
      if (url.startsWith('/api/')) return { status: 200, body: [] };
      return { status: 404, body: {} };
    });
    wrap(<ConnectPanel classId={CLASS_A} revisionId={REVISION} instructor onClose={vi.fn()} />);
    expect(await screen.findByRole('list', { name: 'Class computers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish a class computer' })).toBeInTheDocument();
  });
});
