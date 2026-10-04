package protocol

import (
	"fmt"
	"sync"

	"parallax/connector/protocol"
)

// Code is a key of errors.json: the code of an error, a stream reset or a failed stage.
type Code string

// Every code of errors.json (design §5.4). TestErrorCodesInCatalogue checks this list against
// the file both ways, so the connector cannot emit a code the server and the web app lack.
const (
	CodeHostUnresolved             Code = "host_unresolved"
	CodeConnectionRefused          Code = "connection_refused"
	CodeConnectionTimeout          Code = "connection_timeout"
	CodeNetworkScopeDenied         Code = "network_scope_denied"
	CodeUnsupportedTarget          Code = "unsupported_target"
	CodeInvalidTarget              Code = "invalid_target"
	CodeHostKeyUnknown             Code = "host_key_unknown"
	CodeHostKeyChanged             Code = "host_key_changed"
	CodeHostKeyUntrustedManaged    Code = "host_key_untrusted_managed"
	CodeKeyFileUnreadable          Code = "key_file_unreadable"
	CodeKeyPassphraseRequired      Code = "key_passphrase_required"
	CodeKeyPassphraseWrong         Code = "key_passphrase_wrong"
	CodeAgentUnavailable           Code = "agent_unavailable"
	CodeAgentNoIdentity            Code = "agent_no_identity"
	CodeAuthRejected               Code = "auth_rejected"
	CodeAuthMethodUnsupported      Code = "auth_method_unsupported"
	CodeMfaRequiresTerminal        Code = "mfa_requires_terminal"
	CodeMfaFailed                  Code = "mfa_failed"
	CodeWorkspaceMissing           Code = "workspace_missing"
	CodeWorkspaceNotDirectory      Code = "workspace_not_directory"
	CodeWorkspaceNotWritable       Code = "workspace_not_writable"
	CodeWorkspaceOutsideRoot       Code = "workspace_outside_root"
	CodeForwardingDenied           Code = "forwarding_denied"
	CodeTunnelUnavailable          Code = "tunnel_unavailable"
	CodeRemoteExecDenied           Code = "remote_exec_denied"
	CodeShellUnsupported           Code = "shell_unsupported"
	CodeEnvironmentInvalid         Code = "environment_invalid"
	CodeJupyterMissing             Code = "jupyter_missing"
	CodeJupyterIncompatible        Code = "jupyter_incompatible"
	CodeJupyterStartFailed         Code = "jupyter_start_failed"
	CodeJupyterStartTimeout        Code = "jupyter_start_timeout"
	CodeAttachNoneFound            Code = "attach_none_found"
	CodeAttachPortUnreachable      Code = "attach_port_unreachable"
	CodeAttachNotLoopback          Code = "attach_not_loopback"
	CodeTokenUnavailable           Code = "token_unavailable"
	CodeTokenRejected              Code = "token_rejected"
	CodeNotebookServiceUnreachable Code = "notebook_service_unreachable"
	CodeNoKernelspec               Code = "no_kernelspec"
	CodeKernelspecNotFound         Code = "kernelspec_not_found"
	CodeKernelStartFailed          Code = "kernel_start_failed"
	CodeUnsupportedMessage         Code = "unsupported_message"
	CodeInvalidMessage             Code = "invalid_message"
	CodeUnknownSession             Code = "unknown_session"
	CodeUnknownStream              Code = "unknown_stream"
	CodeNotOwned                   Code = "not_owned"
	CodeLimitExceeded              Code = "limit_exceeded"
	CodePathNotAllowed             Code = "path_not_allowed"
	CodeBodyTooLarge               Code = "body_too_large"
	CodeNotReady                   Code = "not_ready"
	CodeRateLimited                Code = "rate_limited"
	CodeBusy                       Code = "busy"
	CodeTestTimeout                Code = "test_timeout"
	CodeStreamCancelled            Code = "stream_cancelled"
	CodeInternal                   Code = "internal"
)

// Codes lists every code constant.
var Codes = []Code{
	CodeHostUnresolved,
	CodeConnectionRefused,
	CodeConnectionTimeout,
	CodeNetworkScopeDenied,
	CodeUnsupportedTarget,
	CodeInvalidTarget,
	CodeHostKeyUnknown,
	CodeHostKeyChanged,
	CodeHostKeyUntrustedManaged,
	CodeKeyFileUnreadable,
	CodeKeyPassphraseRequired,
	CodeKeyPassphraseWrong,
	CodeAgentUnavailable,
	CodeAgentNoIdentity,
	CodeAuthRejected,
	CodeAuthMethodUnsupported,
	CodeMfaRequiresTerminal,
	CodeMfaFailed,
	CodeWorkspaceMissing,
	CodeWorkspaceNotDirectory,
	CodeWorkspaceNotWritable,
	CodeWorkspaceOutsideRoot,
	CodeForwardingDenied,
	CodeTunnelUnavailable,
	CodeRemoteExecDenied,
	CodeShellUnsupported,
	CodeEnvironmentInvalid,
	CodeJupyterMissing,
	CodeJupyterIncompatible,
	CodeJupyterStartFailed,
	CodeJupyterStartTimeout,
	CodeAttachNoneFound,
	CodeAttachPortUnreachable,
	CodeAttachNotLoopback,
	CodeTokenUnavailable,
	CodeTokenRejected,
	CodeNotebookServiceUnreachable,
	CodeNoKernelspec,
	CodeKernelspecNotFound,
	CodeKernelStartFailed,
	CodeUnsupportedMessage,
	CodeInvalidMessage,
	CodeUnknownSession,
	CodeUnknownStream,
	CodeNotOwned,
	CodeLimitExceeded,
	CodePathNotAllowed,
	CodeBodyTooLarge,
	CodeNotReady,
	CodeRateLimited,
	CodeBusy,
	CodeTestTimeout,
	CodeStreamCancelled,
	CodeInternal,
}

// Entry is one code of the catalogue.
type Entry struct {
	Stage      *string  `json:"stage"`
	Cause      string   `json:"cause"`
	Retryable  bool     `json:"retryable"`
	Recoveries []string `json:"recoveries"`
	Summary    string   `json:"summary"`
}

// LossCause is one cause of a lost session (design §5.5).
type LossCause struct {
	Origin     string   `json:"origin,omitempty"`
	Recoveries []string `json:"recoveries"`
	Summary    string   `json:"summary"`
}

// Catalogue is errors.json.
type Catalogue struct {
	Description string               `json:"description"`
	V           int                  `json:"v"`
	Causes      map[string]string    `json:"causes"`
	Recoveries  []string             `json:"recoveries"`
	Codes       map[Code]Entry       `json:"codes"`
	Loss        map[string]LossCause `json:"loss"`
}

// LoadCatalogue parses the embedded errors.json.
func LoadCatalogue() (*Catalogue, error) {
	data, err := protocol.V1.ReadFile("v1/errors.json")
	if err != nil {
		return nil, err
	}
	var c Catalogue
	if err := strictUnmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("errors.json: %w", err)
	}
	return &c, nil
}

var catalogue = sync.OnceValue(func() *Catalogue {
	c, err := LoadCatalogue()
	if err != nil {
		panic(err)
	}
	return c
})

// Known reports whether c is a key of errors.json.
func (c Code) Known() bool {
	_, ok := catalogue().Codes[c]
	return ok
}

// Lookup returns the catalogue entry of a code.
func Lookup(c Code) (Entry, bool) {
	e, ok := catalogue().Codes[c]
	return e, ok
}
