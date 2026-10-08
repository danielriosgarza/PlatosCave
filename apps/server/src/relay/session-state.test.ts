import { describe, expect, test } from 'vitest';
import {
  nextSessionState,
  SESSION_STATES,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
} from './session-state';

/**
 * Every row of docs/design/connector.md §10.7. Each case lists the states the event moves and
 * where to; every other state must be left as it is (null).
 */

const at = (state: SessionState, cause: string | null = null): SessionStatus => ({ state, cause });

interface Row {
  name: string;
  event: SessionEvent;
  moves: Partial<Record<SessionState, SessionStatus>>;
}

const rows: Row[] = [
  {
    name: 'session_state ready from starting, disconnected or unconfirmed',
    event: { t: 'reported', state: 'ready' },
    moves: {
      starting: at('ready'),
      disconnected: at('ready'),
      unconfirmed: at('ready'),
    },
  },
  {
    name: 'session_state failed from starting stores the code as cause',
    event: { t: 'reported', state: 'failed', code: 'jupyter_missing' },
    moves: { starting: at('failed', 'jupyter_missing') },
  },
  {
    name: "session_state disconnected keeps the connector's cause",
    event: { t: 'reported', state: 'disconnected', cause: 'sleep' },
    moves: {
      ready: at('disconnected', 'sleep'),
      unconfirmed: at('disconnected', 'sleep'),
      disconnected: at('disconnected', 'sleep'),
    },
  },
  {
    name: '45 s without a heartbeat or a closed link makes open sessions unconfirmed',
    event: { t: 'link_lost' },
    moves: {
      starting: at('unconfirmed', 'link_lost'),
      ready: at('unconfirmed', 'link_lost'),
      disconnected: at('unconfirmed', 'link_lost'),
      stopping: at('unconfirmed', 'link_lost'),
    },
  },
  {
    name: 'A32 an accepted stop moves any open state to stopping',
    event: { t: 'stop_sent' },
    moves: {
      starting: at('stopping'),
      ready: at('stopping'),
      disconnected: at('stopping'),
      unconfirmed: at('stopping'),
      stopping: at('stopping'),
    },
  },
  {
    name: 'A36 an open_session refused with limit_exceeded fails with that code',
    event: { t: 'open_refused', code: 'limit_exceeded' },
    moves: { starting: at('failed', 'limit_exceeded') },
  },
  {
    name: 'A36 a failed stop returns to the state before the stop',
    event: { t: 'stop_failed', previous: at('disconnected', 'vpn') },
    moves: { stopping: at('disconnected', 'vpn') },
  },
  {
    name: "A32 session_state stopped from any open state carries the connector's cause",
    event: { t: 'reported', state: 'stopped', cause: 'user_stop' },
    moves: {
      starting: at('stopped', 'user_stop'),
      ready: at('stopped', 'user_stop'),
      disconnected: at('stopped', 'user_stop'),
      unconfirmed: at('stopped', 'user_stop'),
      stopping: at('stopped', 'user_stop'),
    },
  },
  {
    name: 'A36 an unconfirmed session missing from the first heartbeat is connector_restarted',
    event: { t: 'missing_after_hello' },
    moves: { unconfirmed: at('stopped', 'connector_restarted') },
  },
  {
    name: "A36 a heartbeat listing the session as stopped gives the connector's cause",
    event: { t: 'reported', state: 'stopped', cause: 'sleep' },
    moves: {
      starting: at('stopped', 'sleep'),
      ready: at('stopped', 'sleep'),
      disconnected: at('stopped', 'sleep'),
      unconfirmed: at('stopped', 'sleep'),
      stopping: at('stopped', 'sleep'),
    },
  },
  {
    name: 'A36 Forget from disconnected, unconfirmed or stopping is abandoned',
    event: { t: 'forget' },
    moves: {
      disconnected: at('stopped', 'abandoned'),
      unconfirmed: at('stopped', 'abandoned'),
      stopping: at('stopped', 'abandoned'),
    },
  },
  {
    name: 'a revoked connector leaves every open session unconfirmed',
    event: { t: 'revoked' },
    moves: {
      starting: at('unconfirmed', 'connector_revoked'),
      ready: at('unconfirmed', 'connector_revoked'),
      disconnected: at('unconfirmed', 'connector_revoked'),
      unconfirmed: at('unconfirmed', 'connector_revoked'),
      stopping: at('unconfirmed', 'connector_revoked'),
    },
  },
  {
    name: 'A33 removal from the class closes every open session as membership_removed',
    event: { t: 'membership_removed' },
    moves: {
      starting: at('stopped', 'membership_removed'),
      ready: at('stopped', 'membership_removed'),
      disconnected: at('stopped', 'membership_removed'),
      unconfirmed: at('stopped', 'membership_removed'),
      stopping: at('stopped', 'membership_removed'),
    },
  },
  {
    name: 'a session still starting after 300 s fails with test_timeout',
    event: { t: 'start_timeout' },
    moves: { starting: at('failed', 'test_timeout') },
  },
  {
    name: 'a relay start leaves sessions unconfirmed until their connector reports',
    event: { t: 'relay_start' },
    moves: {
      starting: at('unconfirmed', 'link_lost'),
      ready: at('unconfirmed', 'link_lost'),
      disconnected: at('unconfirmed', 'link_lost'),
      stopping: at('unconfirmed', 'link_lost'),
    },
  },
  {
    name: 'starting and stopping reports change nothing',
    event: { t: 'reported', state: 'stopping' },
    moves: {},
  },
];

describe('nextSessionState, the table of §10.7', () => {
  for (const row of rows) {
    test(row.name, () => {
      for (const state of SESSION_STATES) {
        const got = nextSessionState(at(state, 'earlier'), row.event);
        expect(got, `${state} on ${row.event.t}`).toEqual(row.moves[state] ?? null);
      }
    });
  }

  test('A36 a late ready after failed or stopped changes nothing (the relay cleans it up)', () => {
    for (const state of ['failed', 'stopped'] as const) {
      expect(nextSessionState(at(state), { t: 'reported', state: 'ready' })).toBeNull();
    }
  });

  test('a stop never fails back to stopping or to a closed state', () => {
    expect(
      nextSessionState(at('stopping'), { t: 'stop_failed', previous: at('stopped', 'x') }),
    ).toBeNull();
    expect(
      nextSessionState(at('stopping'), { t: 'stop_failed', previous: at('stopping') }),
    ).toBeNull();
  });
});
