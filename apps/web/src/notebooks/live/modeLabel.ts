import { kernelLabel } from '../connect/messages';

/** §5.6: a mode label that names only a state the server read. */
export function modeLabel(args: {
  connectionName: string | undefined;
  language: string;
  sessionState: string;
  kernelState: string | undefined;
  confirmed: boolean;
}): string {
  const { sessionState, kernelState, confirmed } = args;
  let state: string;
  if (sessionState === 'disconnected') state = 'Disconnected';
  else if (sessionState === 'stopping') state = 'Stopping';
  else if (sessionState === 'stopped') state = 'Stopped';
  else if (sessionState === 'failed') state = 'Failed';
  else if (sessionState === 'unconfirmed' || !confirmed) state = 'Unconfirmed';
  else state = kernelLabel(kernelState);
  return `${args.connectionName ?? 'Computer'} · ${args.language} · ${state}`;
}
