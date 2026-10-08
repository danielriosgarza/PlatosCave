/**
 * Interface copy for the connector's error catalogue (docs/design/connector.md §5.4, §5.5;
 * `connector/protocol/v1/errors.json` is the source). Failure text names what went wrong and the
 * recovery, never the host's raw output and never a secret (§5.6). `messages.test.ts` fails when
 * a code, a cause or a recovery of the catalogue has no copy here.
 */

export const STAGE_LABEL: Record<string, string> = {
  reachability: 'Reach the host',
  host_identity: 'Check the host key',
  ssh_auth: 'Sign in over SSH',
  workspace: 'Check the working directory',
  forwarding: 'Open a tunnel',
  runtime: 'Check Jupyter',
  notebook_auth: 'Reach the notebook service',
  kernels: 'Check the kernel',
};

/** One word per kernel state, shared by the connect panel and the live toolbar (§5.6). */
export const KERNEL_LABEL: Record<string, string> = {
  starting: 'Starting',
  idle: 'Ready',
  busy: 'Running',
  waiting_for_input: 'Waiting for input',
  restarting: 'Restarting',
  dead: 'Kernel stopped',
  unknown: 'Unconfirmed',
  lost: 'No kernel',
};

/** The word for a kernel state; a state nobody confirmed reads Unconfirmed. */
export const kernelLabel = (state: string | null | undefined): string =>
  KERNEL_LABEL[state ?? 'unknown'] ?? 'Unconfirmed';

/** What each failing code means for the person, in the words of spec §14's six causes. */
export const CODE_COPY: Record<string, string> = {
  host_unresolved: 'The host name could not be found.',
  connection_refused: 'The host refused the connection on that port.',
  connection_timeout: 'The host did not answer in time.',
  network_scope_denied: 'This connector is not allowed to reach that address.',
  unsupported_target: 'This connector cannot connect to that kind of target.',
  invalid_target: 'Parallax cannot use this target. Check the host, port and account.',
  host_key_unknown: 'This is the first connection to this host. Check its fingerprint.',
  host_key_changed:
    'The key this host presented differs from the one you trusted. Nothing was sent.',
  host_key_untrusted_managed: 'A managed connector connects only to hosts its operator has pinned.',
  key_file_unreadable: 'The key file is missing or this connector cannot read it.',
  key_passphrase_required:
    'The key needs a passphrase and the connector has no terminal to ask in.',
  key_passphrase_wrong: 'The passphrase did not unlock the key.',
  agent_unavailable: 'The connector found no SSH agent on its computer.',
  agent_no_identity: 'The SSH agent holds no key this host accepts.',
  auth_rejected: 'The host rejected every credential offered.',
  auth_method_unsupported:
    'The host accepts only sign-in methods the connector does not support (password or Kerberos).',
  mfa_requires_terminal:
    'The host asks for a second factor and the connector has no terminal to ask in.',
  mfa_failed: 'The second factor was not accepted or was not given in time.',
  workspace_missing: 'The working directory does not exist on that computer.',
  workspace_not_directory: 'The working directory path is not a directory.',
  workspace_not_writable: 'The account cannot write to the working directory.',
  workspace_outside_root: "The Jupyter server's root does not contain the working directory.",
  forwarding_denied: 'The SSH server forbids port forwarding for this account.',
  tunnel_unavailable: 'The tunnel to the notebook service could not be opened.',
  remote_exec_denied: 'This account may not run commands over SSH.',
  shell_unsupported: 'That host is not a POSIX host, so Parallax cannot start Jupyter there.',
  environment_invalid: 'The chosen Python interpreter does not exist or cannot run.',
  jupyter_missing: 'Jupyter Server is not installed in that environment.',
  jupyter_incompatible: 'Jupyter Server in that environment is older than version 2.0.',
  jupyter_start_failed: 'Jupyter exited while starting.',
  jupyter_start_timeout: 'Jupyter did not become ready within 30 seconds.',
  attach_none_found: 'No running Jupyter server was found to attach to.',
  attach_port_unreachable: 'Nothing answered on the port to attach to.',
  attach_not_loopback: 'Only a Jupyter server that listens on loopback can be attached.',
  token_unavailable: "The connector cannot read the server's token, so it cannot attach.",
  token_rejected: "Jupyter rejected the connector's token.",
  notebook_service_unreachable: 'The tunnel is up but Jupyter does not answer through it.',
  no_kernelspec: 'Jupyter lists no kernel.',
  kernelspec_not_found: 'The chosen kernel is not installed there.',
  kernel_start_failed: 'The kernel process would not start.',
  unsupported_message: 'The connector and Parallax do not speak the same version.',
  invalid_message: 'The connector sent a message Parallax could not read.',
  unknown_session: 'The connector does not know this session.',
  unknown_stream: 'The connection to the notebook service closed.',
  not_owned:
    'Parallax did not start this Jupyter server, so it cannot stop it. Disconnect leaves it running.',
  limit_exceeded: 'A connector limit was reached.',
  path_not_allowed: 'The connector refused a request outside what it may do.',
  body_too_large: 'A request or reply was too large.',
  not_ready: 'The session or kernel is not ready to run a cell.',
  rate_limited: 'Too many requests. Wait a moment.',
  busy: 'The session is busy with a previous request.',
  test_timeout: 'The test did not finish in time.',
  stream_cancelled: 'The request was cancelled.',
  internal: 'The connector failed unexpectedly. Its log has the details.',
};

/** Why a session was lost (§5.5): the true cause, never a claim that the process survived. */
export const CAUSE_COPY: Record<string, string> = {
  sleep: 'This computer was asleep. Its processes were paused or ended.',
  vpn: 'A VPN connection went away or the route to the host moved.',
  network_change: "This computer's network changed.",
  ssh_timeout: 'The SSH connection stopped answering.',
  service_stopped: 'SSH works but the Jupyter service is no longer running.',
  allocation_expired: 'The time-limited allocation on that computer ended.',
  host_unreachable: 'The host cannot be reached now.',
  process_exited: 'The Jupyter process ended on its own.',
  lease_idle: 'The session stopped after the idle timeout.',
  lease_grace: 'The session stopped because no browser was attached for the grace period.',
  user_stop: 'The session was stopped.',
  connector_exit: 'The connector was stopped.',
  connector_restarted: 'The connector restarted and could not rejoin the session.',
  abandoned: 'You gave up on this session. Parallax does not know whether it still runs.',
  max_lifetime: 'The session reached its maximum lifetime of 12 hours.',
  link_lost: 'Parallax stopped hearing from the connector. The session may still be running.',
  connector_offline: 'The connector is not connected to Parallax.',
  connector_revoked: 'This device was revoked or unpaired.',
  kernel_lost: 'The kernel no longer exists. Its variables are gone.',
  membership_removed: 'You were removed from this class, so the session was closed.',
};

/** The recovery steps of the catalogue as sentences; a few also have a button in the panel. */
export const RECOVERY_COPY: Record<string, string> = {
  retry: 'Try again.',
  wait: 'Wait a moment, then try again.',
  check_address: 'Check the host name, port and account.',
  check_network: "Check this computer's network.",
  start_vpn: 'Start the VPN the host needs.',
  verify_host_key: 'Compare the fingerprint with the host owner, then trust it.',
  replace_host_key: 'If the host owner confirms the key changed, replace the trusted key.',
  contact_host_owner: "Ask the host's owner.",
  use_agent: 'Load the key into an SSH agent on the connector computer.',
  unlock_key: 'Run the connector in a terminal and enter the passphrase there.',
  choose_key: 'Choose a key file the connector can read.',
  run_in_terminal: 'Run the connector in a terminal so it can ask you.',
  enable_forwarding: 'Ask the host owner to allow port forwarding for your account.',
  install_jupyter: 'Install Jupyter Server 2.0 or newer in that environment.',
  choose_environment: 'Choose another Python interpreter or kernel.',
  start_jupyter_then_attach: 'Start Jupyter yourself on that computer, then attach to it.',
  choose_workspace: 'Choose a working directory that exists and that you can write to.',
  pick_other_target: 'Choose another target.',
  download_notebook: 'Download the notebook and run it elsewhere.',
  reconnect: 'Reconnect.',
  new_session: 'Start a new session.',
  update_connector: 'Update the connector.',
  allow_network: "Ask the connector's owner to allow that network.",
  none: '',
};

/** Words of the six causes of spec §14, plus the ones the catalogue adds. */
export const CATALOGUE_CAUSE_COPY: Record<string, string> = {
  reachability: 'Reachability',
  host_key: 'Host key',
  authentication: 'Authentication',
  workspace: 'Working directory',
  tunnel: 'Tunnel',
  runtime: 'Runtime',
  kernel: 'Kernel',
  policy: 'Policy',
  protocol: 'Connector link',
};

/** Codes only the server gives a test that ended without the connector's result. */
const SERVER_CODE_COPY: Record<string, string> = {
  connector_offline:
    'That computer is not connected to Parallax. Start the connector there and try again.',
  template_mismatch:
    'A connection to a class computer keeps the host, working directory, Jupyter settings and session times its instructor set. Make a new connection from the class computer instead.',
  workspace_needs_user:
    'On a computer with an account per student, the working directory must contain {user}.',
};

export const codeText = (code: string | undefined): string =>
  (code && (CODE_COPY[code] ?? SERVER_CODE_COPY[code])) ||
  'The check failed for a reason Parallax does not recognise.';

export const causeText = (cause: string | null | undefined): string =>
  (cause && CAUSE_COPY[cause]) || 'The session ended for a reason Parallax does not recognise.';

/** Recovery sentences for a code in the catalogue's order; those with a button elsewhere are named. */
export const recoveryText = (recoveries: readonly string[]): string[] =>
  recoveries.map((r) => RECOVERY_COPY[r] ?? '').filter((s) => s !== '');

/**
 * Ordered recoveries per code and per loss cause, mirroring `errors.json`; `messages.test.ts`
 * compares them with the file so they cannot drift.
 */
export const CODE_RECOVERIES: Record<string, string[]> = {
  host_unresolved: ['check_address', 'check_network', 'retry'],
  connection_refused: ['check_address', 'contact_host_owner', 'retry'],
  connection_timeout: ['check_network', 'start_vpn', 'retry'],
  network_scope_denied: ['allow_network', 'pick_other_target'],
  unsupported_target: ['pick_other_target', 'update_connector'],
  invalid_target: ['check_address'],
  host_key_unknown: ['verify_host_key'],
  host_key_changed: ['contact_host_owner', 'replace_host_key', 'pick_other_target'],
  host_key_untrusted_managed: ['contact_host_owner'],
  key_file_unreadable: ['choose_key', 'use_agent'],
  key_passphrase_required: ['run_in_terminal', 'use_agent'],
  key_passphrase_wrong: ['unlock_key', 'retry'],
  agent_unavailable: ['use_agent', 'choose_key'],
  agent_no_identity: ['use_agent', 'choose_key'],
  auth_rejected: ['choose_key', 'contact_host_owner'],
  auth_method_unsupported: ['contact_host_owner', 'pick_other_target'],
  mfa_requires_terminal: ['run_in_terminal'],
  mfa_failed: ['retry'],
  workspace_missing: ['choose_workspace'],
  workspace_not_directory: ['choose_workspace'],
  workspace_not_writable: ['choose_workspace', 'contact_host_owner'],
  workspace_outside_root: ['choose_workspace'],
  forwarding_denied: ['enable_forwarding', 'pick_other_target', 'download_notebook'],
  tunnel_unavailable: ['retry'],
  remote_exec_denied: ['contact_host_owner', 'start_jupyter_then_attach', 'pick_other_target'],
  shell_unsupported: ['start_jupyter_then_attach'],
  environment_invalid: ['choose_environment'],
  jupyter_missing: ['install_jupyter', 'choose_environment'],
  jupyter_incompatible: ['install_jupyter', 'choose_environment'],
  jupyter_start_failed: ['retry', 'choose_environment'],
  jupyter_start_timeout: ['retry', 'wait'],
  attach_none_found: ['start_jupyter_then_attach', 'choose_environment'],
  attach_port_unreachable: ['start_jupyter_then_attach', 'retry'],
  attach_not_loopback: ['pick_other_target'],
  token_unavailable: ['start_jupyter_then_attach', 'choose_environment'],
  token_rejected: ['choose_environment', 'contact_host_owner'],
  notebook_service_unreachable: ['retry', 'start_jupyter_then_attach'],
  no_kernelspec: ['install_jupyter', 'choose_environment'],
  kernelspec_not_found: ['choose_environment'],
  kernel_start_failed: ['retry', 'choose_environment'],
  unsupported_message: ['update_connector'],
  invalid_message: ['update_connector'],
  unknown_session: ['new_session'],
  unknown_stream: ['retry'],
  not_owned: ['none'],
  limit_exceeded: ['wait', 'retry'],
  path_not_allowed: ['none'],
  body_too_large: ['none'],
  not_ready: ['wait', 'retry'],
  rate_limited: ['wait'],
  busy: ['wait', 'retry'],
  test_timeout: ['retry'],
  stream_cancelled: ['retry'],
  internal: ['retry'],
};

export const CAUSE_RECOVERIES: Record<string, string[]> = {
  sleep: ['reconnect', 'new_session'],
  vpn: ['start_vpn', 'reconnect', 'pick_other_target'],
  network_change: ['check_network', 'reconnect'],
  ssh_timeout: ['reconnect', 'pick_other_target'],
  service_stopped: ['new_session', 'reconnect'],
  allocation_expired: ['pick_other_target', 'new_session'],
  host_unreachable: ['check_network', 'reconnect', 'pick_other_target'],
  process_exited: ['new_session'],
  lease_idle: ['new_session'],
  lease_grace: ['new_session'],
  user_stop: ['new_session'],
  connector_exit: ['new_session'],
  connector_restarted: ['new_session'],
  abandoned: ['pick_other_target', 'new_session'],
  max_lifetime: ['new_session'],
  link_lost: ['reconnect'],
  connector_offline: ['reconnect'],
  connector_revoked: ['pick_other_target', 'new_session'],
  kernel_lost: ['new_session'],
  membership_removed: ['new_session'],
};
