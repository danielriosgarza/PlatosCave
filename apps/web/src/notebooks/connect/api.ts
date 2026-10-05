import {
  archiveConnection,
  createConnection,
  getConnectionTest,
  listConnections,
  startConnectionTest,
  updateConnection,
} from '@parallax/contracts/routes/connections';
import {
  approveConnector,
  createConnectorPairing,
  listConnectors,
  renameConnector,
  revokeConnector,
} from '@parallax/contracts/routes/connectors';
import {
  closeNotebookSession,
  forgetNotebookSession,
  getNotebookSession,
  getSessionKernel,
  listNotebookSessions,
  openNotebookSession,
  restartSessionKernel,
  startSessionKernel,
} from '@parallax/contracts/routes/notebookSessions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../../api/client';

export type Connector = z.output<typeof listConnectors.response>[number];
export type Connection = z.output<typeof listConnections.response>[number];
export type ConnectionTarget = Connection['target'];
export type ConnectionRuntime = Connection['runtime'];
export type ConnectionTest = z.output<typeof getConnectionTest.response>;
export type Stage = ConnectionTest['stages'][number];
export type NotebookSession = z.output<typeof getNotebookSession.response>;
/** A host key the person confirmed; `replacing` names the key it replaces (§5.2). */
export interface Confirmation {
  host: string;
  port: number;
  sha256: string;
  replacing?: string;
}

export interface NewConnection {
  name: string;
  connectorId: string;
  target: ConnectionTarget;
  runtime: ConnectionRuntime;
}

export interface ConnectionChange {
  name?: string;
  target?: ConnectionTarget;
  runtime?: ConnectionRuntime;
}

export interface SessionRequest {
  connectionId: string;
  revisionId: string;
  runtime?: ConnectionRuntime;
  lease?: { idleTimeoutMin: number; gracePeriodMin: number };
}

/** The refusal's `error` field of an API answer, if it has one. */
export const errorCode = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.body as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : undefined;
};

const DEVICES_POLL_MS = 3000;

/** This person's connectors; while one is pending the list is read again every few seconds. */
export const useConnectors = (pairingLive = false) =>
  useQuery({
    queryKey: [listConnectors.method, listConnectors.path],
    queryFn: () => call(listConnectors),
    refetchInterval: (query) =>
      pairingLive || query.state.data?.some((c) => c.status === 'pending')
        ? DEVICES_POLL_MS
        : false,
  });

const refreshConnectors = (client: ReturnType<typeof useQueryClient>) =>
  client.invalidateQueries({ queryKey: [listConnectors.method, listConnectors.path] });

export function useConnectorActions() {
  const client = useQueryClient();
  const done = () => refreshConnectors(client);
  return {
    pair: useMutation({ mutationFn: () => call(createConnectorPairing), onSuccess: done }),
    approve: useMutation({
      mutationFn: (connectorId: string) => call(approveConnector, { params: { connectorId } }),
      onSuccess: done,
    }),
    revoke: useMutation({
      mutationFn: (connectorId: string) => call(revokeConnector, { params: { connectorId } }),
      onSuccess: done,
    }),
    rename: useMutation({
      mutationFn: (v: { connectorId: string; name: string }) =>
        call(renameConnector, { params: { connectorId: v.connectorId }, body: { name: v.name } }),
      onSuccess: done,
    }),
  };
}

export const useConnections = () => useApi(listConnections);

export function useConnectionActions() {
  const client = useQueryClient();
  const done = () =>
    client.invalidateQueries({ queryKey: [listConnections.method, listConnections.path] });
  return {
    create: useMutation({
      mutationFn: (body: NewConnection) => call(createConnection, { body }),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: { connectionId: string; body: ConnectionChange }) =>
        call(updateConnection, { params: { connectionId: v.connectionId }, body: v.body }),
      onSuccess: done,
    }),
    archive: useMutation({
      mutationFn: (connectionId: string) => call(archiveConnection, { params: { connectionId } }),
      onSuccess: done,
    }),
  };
}

export const startTest = (connectionId: string, confirmations?: Confirmation[]) =>
  call(startConnectionTest, {
    params: { connectionId },
    body: confirmations ? { confirmations } : {},
  });

const TEST_POLL_MS = 1000;

/** The result of one test, asked again every second until it is done (§10.3). */
export const useConnectionTest = (connectionId: string | undefined, testId: string | undefined) =>
  useQuery({
    queryKey: [getConnectionTest.method, getConnectionTest.path, connectionId, testId],
    enabled: Boolean(connectionId && testId),
    queryFn: () =>
      call(getConnectionTest, {
        params: { connectionId: connectionId as string, testId: testId as string },
      }),
    refetchInterval: (query) => (query.state.data?.state === 'done' ? false : TEST_POLL_MS),
    retry: false,
  });

const SESSION_POLL_MS = 1000;
const SESSION_WATCH_MS = 3000;
const OPEN_STATES = new Set(['starting', 'ready', 'disconnected', 'unconfirmed', 'stopping']);
export const isOpenState = (state: string) => OPEN_STATES.has(state);

/** This class's sessions of this person; the open one for a notebook is the one Connect reuses. */
export const useSessions = (classId: string) =>
  useApi(listNotebookSessions, { params: { classId } });

/**
 * One session, read again every few seconds in every open state (Parallax shows only what it
 * read: a ready session can become disconnected while the panel is open) until it has ended.
 */
export const useNotebookSession = (classId: string, sessionId: string | undefined) =>
  useQuery({
    queryKey: [getNotebookSession.method, getNotebookSession.path, classId, sessionId],
    enabled: Boolean(sessionId),
    queryFn: () =>
      call(getNotebookSession, {
        params: { classId, sessionId: sessionId as string },
      }),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === 'starting' || state === 'stopping') return SESSION_POLL_MS;
      return state && isOpenState(state) ? SESSION_WATCH_MS : false;
    },
  });

/** The relay's view of the kernel: Ready is shown only when it reports `idle` (§5.6). */
export const useKernel = (classId: string, sessionId: string | undefined, active: boolean) =>
  useQuery({
    queryKey: [getSessionKernel.method, getSessionKernel.path, classId, sessionId],
    enabled: Boolean(sessionId) && active,
    queryFn: () => call(getSessionKernel, { params: { classId, sessionId: sessionId as string } }),
    refetchInterval: (query) =>
      query.state.data?.kernel?.state === 'idle' ? SESSION_WATCH_MS : SESSION_POLL_MS,
  });

export function useSessionActions(classId: string) {
  const client = useQueryClient();
  const done = () =>
    client.invalidateQueries({ queryKey: [getNotebookSession.method, getNotebookSession.path] });
  const refreshList = () =>
    client.invalidateQueries({
      queryKey: [listNotebookSessions.method, listNotebookSessions.path],
    });
  return {
    open: useMutation({
      mutationFn: (body: SessionRequest) =>
        call(openNotebookSession, { params: { classId }, body }),
      onSuccess: refreshList,
    }),
    close: useMutation({
      mutationFn: (v: { sessionId: string; stop: boolean }) =>
        call(closeNotebookSession, {
          params: { classId, sessionId: v.sessionId },
          body: { stop: v.stop },
        }),
      onSuccess: () => Promise.all([done(), refreshList()]),
    }),
    forget: useMutation({
      mutationFn: (sessionId: string) =>
        call(forgetNotebookSession, { params: { classId, sessionId } }),
      onSuccess: () => Promise.all([done(), refreshList()]),
    }),
  };
}

/** Starts the chosen kernel in a ready session. A kernel that already exists is not an error. */
export const startKernel = async (classId: string, sessionId: string, kernelName: string) => {
  try {
    return await call(startSessionKernel, {
      params: { classId, sessionId },
      body: { kernelName },
    });
  } catch (error) {
    if (errorCode(error) === 'kernel_exists') return null;
    throw error;
  }
};

/** Restarts the session's kernel; its variables are lost (design §10.6). */
export const restartKernel = (classId: string, sessionId: string) =>
  call(restartSessionKernel, { params: { classId, sessionId } });
