package protocol

import (
	"fmt"
	"regexp"
	"unicode/utf8"
)

// The checks below are the value rules of link.schema.json; key presence and unknown keys are
// checked while decoding. TestDecodeAgreesWithSchema compares them with the schema itself.

var (
	reUUID           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reB64URL32       = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	reB64URL64       = regexp.MustCompile(`^[A-Za-z0-9_-]{86}$`)
	reFingerprint    = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
	reSemver         = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
	reTimestamp      = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
	reCode           = regexp.MustCompile(`^[a-z][a-z0-9_]{2,47}$`)
	reDetail         = regexp.MustCompile(`^[^\x00-\x08\x0b-\x1f\x7f]*$`)
	reHost           = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
	reUser           = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$`)
	rePath           = regexp.MustCompile(`^[^\x00-\x1f\x7f]+$`)
	reCIDR           = regexp.MustCompile(`^[0-9A-Fa-f:.]+/[0-9]{1,3}$`)
	reHostPattern    = regexp.MustCompile(`^(\*\.)?[A-Za-z0-9.-]+$`)
	reKernelName     = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`)
	reManagedID      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	reKernelspecName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	reJupyterVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+(\.[0-9]+)?[A-Za-z0-9.+-]*$`)
	reOrigin         = regexp.MustCompile(`^https?://[a-z0-9.:\[\]-]+$`)
	reHeaderName     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	reHeaderValue    = regexp.MustCompile(`^[^\x00-\x1f\x7f]*$`)
	reAPIPath        = regexp.MustCompile(`^/api/[A-Za-z0-9._~%/:@!$&'()*+,;=?-]*$`)
	reWSProtocol     = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	reKernelID       = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	reContentRoot    = regexp.MustCompile(`^([^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*(/[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*)*)?$`)
)

const maxUnixSeconds = 4102444800

func length(s string) int { return utf8.RuneCountInString(s) }

func match(field string, re *regexp.Regexp, s string, maxLen int) error {
	if maxLen > 0 && length(s) > maxLen {
		return fmt.Errorf("%s is longer than %d characters", field, maxLen)
	}
	if !re.MatchString(s) {
		return fmt.Errorf("%s %q has the wrong form", field, clip(s))
	}
	return nil
}

func maxLen(field, s string, n int) error {
	if length(s) > n {
		return fmt.Errorf("%s is longer than %d characters", field, n)
	}
	return nil
}

func oneOf(field, s string, values ...string) error {
	for _, v := range values {
		if s == v {
			return nil
		}
	}
	return fmt.Errorf("%s %q is not one of %v", field, clip(s), values)
}

func between(field string, n, lo, hi int64) error {
	if n < lo || n > hi {
		return fmt.Errorf("%s %d is outside %d…%d", field, n, lo, hi)
	}
	return nil
}

func clip(s string) string {
	if len(s) > 40 {
		return s[:40] + "…"
	}
	return s
}

func optional(s string, check func() error) error {
	if s == "" {
		return nil
	}
	return check()
}

func first(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func uuid(field, s string) error              { return match(field, reUUID, s, 0) }
func unixSeconds(field string, n int64) error { return between(field, n, 0, maxUnixSeconds) }
func timestamp(field, s string) error         { return match(field, reTimestamp, s, 0) }
func fingerprint(field, s string) error       { return match(field, reFingerprint, s, 0) }
func host(field, s string) error              { return match(field, reHost, s, 253) }
func port(field string, n int) error          { return between(field, int64(n), 1, 65535) }
func path(field, s string) error              { return match(field, rePath, s, 1024) }
func detail(s string) error                   { return match("detail", reDetail, s, 512) }
func streamID(n uint32) error                 { return between("streamId", int64(n), 1, 4294967295) }

func (c Code) check(field string) error { return match(field, reCode, string(c), 0) }

var (
	stageNames = []string{"reachability", "host_identity", "ssh_auth", "workspace", "forwarding", "runtime", "notebook_auth", "kernels"}
	causes     = []string{"sleep", "vpn", "network_change", "ssh_timeout", "service_stopped", "allocation_expired",
		"host_unreachable", "process_exited", "lease_idle", "lease_grace", "user_stop", "connector_exit",
		"connector_restarted", "max_lifetime"}
	sessionStates = []string{"starting", "ready", "disconnected", "stopping", "stopped", "failed"}
)

func (m *Challenge) validate() error {
	return first(
		match("nonce", reB64URL32, m.Nonce, 0),
		match("origin", reOrigin, m.Origin, 255),
		unixSeconds("ts", m.TS),
	)
}

func (m *Auth) validate() error {
	return first(
		uuid("connectorId", m.ConnectorID),
		unixSeconds("ts", m.TS),
		match("sig", reB64URL64, m.Sig, 0),
	)
}

func (m *AuthOK) validate() error {
	l := m.Limits
	return first(
		between("heartbeatSeconds", int64(m.HeartbeatSeconds), 5, 60),
		between("limits.maxStreams", int64(l.MaxStreams), 1, 256),
		between("limits.maxPayload", int64(l.MaxPayload), 1024, 1048576),
		between("limits.initialWindow", int64(l.InitialWindow), 4096, 16777216),
		between("limits.maxControl", int64(l.MaxControl), 4096, 1048576),
		between("limits.maxSessions", int64(l.MaxSessions), 1, 64),
		optional(m.MinVersion, func() error { return match("minVersion", reSemver, m.MinVersion, 32) }),
	)
}

func (m *Hello) validate() error {
	if err := first(
		match("version", reSemver, m.Version, 32),
		oneOf("os", m.OS, "linux", "darwin", "windows"),
		oneOf("arch", m.Arch, "amd64", "arm64"),
		oneOf("mode", m.Mode, "personal", "managed"),
	); err != nil {
		return err
	}
	if len(m.Targets) < 1 || len(m.Targets) > 3 {
		return fmt.Errorf("targets must list 1 to 3 kinds")
	}
	seen := map[string]bool{}
	for _, t := range m.Targets {
		if err := oneOf("targets[]", t, TargetLocal, TargetSSH, TargetManaged); err != nil {
			return err
		}
		if seen[t] {
			return fmt.Errorf("targets lists %q twice", t)
		}
		seen[t] = true
	}
	s := m.NetworkScope
	if len(s.CIDRs) > 64 || len(s.Hosts) > 64 {
		return fmt.Errorf("networkScope lists more than 64 entries")
	}
	for _, c := range s.CIDRs {
		if err := match("networkScope.cidrs[]", reCIDR, c, 49); err != nil {
			return err
		}
	}
	for _, h := range s.Hosts {
		if err := match("networkScope.hosts[]", reHostPattern, h, 253); err != nil {
			return err
		}
	}
	return nil
}

func (a *AuthRef) check(field string) error {
	switch a.Method {
	case AuthKey:
		return path(field+".keyPath", a.KeyPath)
	case AuthAgent:
		return maxLen(field+".hint", a.Hint, 128)
	case AuthManagedKey:
		return match(field+".keyId", reManagedID, a.KeyID, 0)
	}
	return fmt.Errorf("%s.method %q is unknown", field, a.Method)
}

func (h *Hop) check(field string) error {
	if err := first(host(field+".host", h.Host), port(field+".port", h.Port), match(field+".user", reUser, h.User, 0)); err != nil {
		return err
	}
	if h.Auth != nil {
		return h.Auth.check(field + ".auth")
	}
	return nil
}

func (t *Target) check() error {
	switch t.Kind {
	case TargetLocal:
		return path("target.workspace", t.Workspace)
	case TargetManaged:
		return first(match("target.targetId", reManagedID, t.TargetID, 0), uuid("target.subject", t.Subject))
	case TargetSSH:
	default:
		return fmt.Errorf("target.kind %q is unknown", t.Kind)
	}
	if t.Auth == nil {
		return fmt.Errorf("target.auth is required")
	}
	if err := first(
		host("target.host", t.Host),
		port("target.port", t.Port),
		match("target.user", reUser, t.User, 0),
		t.Auth.check("target.auth"),
		path("target.workspace", t.Workspace),
		optional(t.ExpectedEnd, func() error { return timestamp("target.expectedEnd", t.ExpectedEnd) }),
	); err != nil {
		return err
	}
	if t.Jump != nil {
		if err := t.Jump.check("target.jump"); err != nil {
			return err
		}
	}
	if len(t.HostKeys) > 2 {
		return fmt.Errorf("target.hostKeys lists more than 2 keys")
	}
	for _, k := range t.HostKeys {
		if err := first(host("target.hostKeys[].host", k.Host), port("target.hostKeys[].port", k.Port),
			fingerprint("target.hostKeys[].sha256", k.SHA256)); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) check() error {
	var err error
	switch r.Mode {
	case RuntimeStart:
		err = optional(r.Python, func() error { return path("runtime.python", r.Python) })
	case RuntimeAttach:
		err = between("runtime.port", int64(r.Port), 1024, 65535)
		if err == nil && r.PID != 0 {
			err = between("runtime.pid", r.PID, 1, 4194304)
		}
	default:
		return fmt.Errorf("runtime.mode %q is unknown", r.Mode)
	}
	if err != nil {
		return err
	}
	return optional(r.KernelName, func() error { return match("runtime.kernelName", reKernelName, r.KernelName, 0) })
}

func (m *TestConnection) validate() error {
	if err := first(uuid("requestId", m.RequestID), m.Target.check(), m.Runtime.check()); err != nil {
		return err
	}
	if len(m.Confirmations) > 2 {
		return fmt.Errorf("confirmations lists more than 2 keys")
	}
	for _, c := range m.Confirmations {
		if err := first(host("confirmations[].host", c.Host), port("confirmations[].port", c.Port),
			fingerprint("confirmations[].sha256", c.SHA256),
			optional(c.Replacing, func() error { return fingerprint("confirmations[].replacing", c.Replacing) })); err != nil {
			return err
		}
	}
	return nil
}

func (d *StageData) check() error {
	if err := first(
		optional(d.Hop, func() error { return oneOf("data.hop", d.Hop, "jump", "target") }),
		maxLen("data.address", d.Address, 45),
		optional(d.Fingerprint, func() error { return fingerprint("data.fingerprint", d.Fingerprint) }),
		optional(d.Expected, func() error { return fingerprint("data.expected", d.Expected) }),
		optional(d.Presented, func() error { return fingerprint("data.presented", d.Presented) }),
		maxLen("data.algorithm", d.Algorithm, 32),
		optional(d.ResolvedPath, func() error { return path("data.resolvedPath", d.ResolvedPath) }),
		optional(d.RootDir, func() error { return path("data.rootDir", d.RootDir) }),
		maxLen("data.version", d.Version, 32),
		optional(d.Reason, func() error { return oneOf("data.reason", d.Reason, "blocked", "not_started", "not_applicable") }),
		optional(d.BlockedBy, func() error { return oneOf("data.blockedBy", d.BlockedBy, stageNames...) }),
		optional(d.State, func() error { return oneOf("data.state", d.State, "startable", "running") }),
		optional(d.Source, func() error { return oneOf("data.source", d.Source, "cli", "service") }),
	); err != nil {
		return err
	}
	if d.Hops != nil {
		if len(d.Hops) < 1 || len(d.Hops) > 2 {
			return fmt.Errorf("data.hops must list 1 or 2 hops")
		}
		for _, h := range d.Hops {
			if err := first(oneOf("data.hops[].hop", h.Hop, "jump", "target"),
				fingerprint("data.hops[].fingerprint", h.Fingerprint), maxLen("data.hops[].address", h.Address, 45)); err != nil {
				return err
			}
		}
		if len(d.Hops) == 2 && (d.Hops[0].Hop != "jump" || d.Hops[1].Hop != "target") {
			return fmt.Errorf("data.hops must list the jump host first, then the target")
		}
	}
	return nil
}

// check applies the stage rules, including the if/then rules of the schema's `stage`.
func (s *Stage) check(inResult bool) error {
	if err := first(
		oneOf("stage.name", s.Name, stageNames...),
		oneOf("stage.status", s.Status, "ok", "failed", "skipped", "needs_action", "running"),
		optional(string(s.Code), func() error { return s.Code.check("stage.code") }),
		detail(s.Detail),
	); err != nil {
		return err
	}
	if s.MS != nil {
		if err := between("stage.ms", *s.MS, 0, 3600000); err != nil {
			return err
		}
	}
	d := s.Data
	if d != nil {
		if err := d.check(); err != nil {
			return err
		}
	}
	if s.Status == "running" {
		switch {
		case inResult:
			return fmt.Errorf("a running stage exists only in test_progress")
		case d == nil || d.TerminalPrompt == nil || !*d.TerminalPrompt:
			return fmt.Errorf("a running stage carries data.terminalPrompt: true")
		case s.Code != "":
			return fmt.Errorf("a running stage has no code")
		case s.Name != "ssh_auth":
			return fmt.Errorf("only ssh_auth may be running")
		}
	}
	if s.Name != "host_identity" {
		if d != nil && (d.Hops != nil || d.Fingerprint != "" || d.Expected != "" || d.Presented != "" || d.Algorithm != "") {
			return fmt.Errorf("only host_identity reports host keys")
		}
		return nil
	}
	switch {
	case s.Status == "ok":
		if d == nil || d.Hops == nil {
			return fmt.Errorf("an ok host_identity stage lists its hops in data.hops")
		}
		if d.Hop != "" || d.Fingerprint != "" || d.Expected != "" || d.Presented != "" || d.Algorithm != "" {
			return fmt.Errorf("an ok host_identity stage reports only data.hops")
		}
	case s.Status == "needs_action":
		if d == nil || d.Hop == "" || d.Fingerprint == "" {
			return fmt.Errorf("a host_identity stage that needs action names data.hop and data.fingerprint")
		}
	}
	if s.Code == "host_key_changed" && (d == nil || d.Hop == "" || d.Expected == "" || d.Presented == "") {
		return fmt.Errorf("host_key_changed names data.hop, data.expected and data.presented")
	}
	return nil
}

func (m *TestProgress) validate() error {
	return first(uuid("requestId", m.RequestID), m.Stage.check(false))
}

func checkKernelspecs(ks []Kernelspec) error {
	if len(ks) > 32 {
		return fmt.Errorf("kernelspecs lists more than 32 kernels")
	}
	for _, k := range ks {
		if err := first(match("kernelspecs[].name", reKernelspecName, k.Name, 0),
			maxLen("kernelspecs[].displayName", k.DisplayName, 128), maxLen("kernelspecs[].language", k.Language, 32)); err != nil {
			return err
		}
	}
	return nil
}

func (e *Environment) check() error {
	if e == nil {
		return nil
	}
	return first(maxLen("environment.os", e.OS, 64), maxLen("environment.arch", e.Arch, 16), maxLen("environment.runtime", e.Runtime, 64))
}

func (m *TestResult) validate() error {
	if err := first(
		uuid("requestId", m.RequestID),
		oneOf("outcome", m.Outcome, "ready", "ready_to_start", "needs_action", "failed"),
		optional(m.JupyterVersion, func() error { return match("jupyterVersion", reJupyterVersion, m.JupyterVersion, 32) }),
		checkKernelspecs(m.Kernelspecs),
		m.Environment.check(),
	); err != nil {
		return err
	}
	if len(m.Stages) < 1 || len(m.Stages) > 8 {
		return fmt.Errorf("stages must list 1 to 8 stages")
	}
	for i := range m.Stages {
		if err := m.Stages[i].check(true); err != nil {
			return err
		}
	}
	if len(m.Attachable) > 16 {
		return fmt.Errorf("attachable lists more than 16 servers")
	}
	for _, a := range m.Attachable {
		if err := first(between("attachable[].port", int64(a.Port), 1024, 65535), path("attachable[].rootDir", a.RootDir)); err != nil {
			return err
		}
		if a.PID != 0 {
			if err := between("attachable[].pid", a.PID, 1, 4194304); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *OpenSession) validate() error {
	return first(
		uuid("requestId", m.RequestID),
		uuid("sessionId", m.SessionID),
		m.Target.check(),
		m.Runtime.check(),
		between("lease.idleTimeoutMin", int64(m.Lease.IdleTimeoutMin), 5, 240),
		between("lease.gracePeriodMin", int64(m.Lease.GracePeriodMin), 1, 60),
	)
}

func (m *SessionState) validate() error {
	return first(
		uuid("sessionId", m.SessionID),
		optional(m.RequestID, func() error { return uuid("requestId", m.RequestID) }),
		oneOf("state", m.State, sessionStates...),
		optional(m.Phase, func() error { return oneOf("phase", m.Phase, "attached", "detached") }),
		optional(m.Cause, func() error { return oneOf("cause", m.Cause, causes...) }),
		optional(string(m.Code), func() error { return m.Code.check("code") }),
		detail(m.Detail),
		maxLen("jupyterVersion", m.JupyterVersion, 32),
		checkKernelspecs(m.Kernelspecs),
		m.Environment.check(),
		checkContentRoot(m.ContentRoot),
		optional(m.LeaseExpiresAt, func() error { return timestamp("leaseExpiresAt", m.LeaseExpiresAt) }),
		unixSeconds("ts", m.TS),
	)
}

// checkContentRoot applies the contentRoot rule: absent, or "" or `/`-separated names of design
// §7 (none empty, `.`, `..` or hidden, no backslash or control character), at most 1024.
func checkContentRoot(root *string) error {
	if root == nil {
		return nil
	}
	return match("contentRoot", reContentRoot, *root, 1024)
}

// ValidContentRoot reports whether root may be sent as session_state.contentRoot.
func ValidContentRoot(root string) bool { return checkContentRoot(&root) == nil }

func (m *CloseSession) validate() error {
	return first(uuid("requestId", m.RequestID), uuid("sessionId", m.SessionID))
}

func (m *Presence) validate() error { return uuid("sessionId", m.SessionID) }

func (m *Activity) validate() error { return uuid("sessionId", m.SessionID) }

func (h Headers) check() error {
	if len(h) > 16 {
		return fmt.Errorf("headers lists more than 16 headers")
	}
	for k, v := range h {
		if err := first(match("headers name", reHeaderName, k, 0), match("headers["+clip(k)+"]", reHeaderValue, v, 1024)); err != nil {
			return err
		}
	}
	return nil
}

func (m *HTTP) validate() error {
	if err := first(
		streamID(m.StreamID),
		uuid("sessionId", m.SessionID),
		oneOf("purpose", m.Purpose, "session", "contents"),
		oneOf("method", m.Method, "GET", "POST", "PUT", "PATCH", "DELETE"),
		match("path", reAPIPath, m.Path, 2048),
		m.Headers.check(),
		oneOf("body", m.Body, "none", "stream"),
	); err != nil {
		return err
	}
	if m.ContentLength != nil {
		if err := between("contentLength", *m.ContentLength, 0, 67108864); err != nil {
			return err
		}
	} else if m.Body == "stream" {
		return fmt.Errorf("a streamed body announces contentLength")
	}
	return nil
}

func (m *HTTPHead) validate() error {
	return first(
		streamID(m.StreamID),
		between("status", int64(m.Status), 100, 599),
		m.Headers.check(),
		oneOf("body", m.Body, "none", "stream"),
	)
}

func (m *WSOpen) validate() error {
	if err := first(streamID(m.StreamID), uuid("sessionId", m.SessionID), match("path", reAPIPath, m.Path, 2048)); err != nil {
		return err
	}
	if len(m.Protocols) > 4 {
		return fmt.Errorf("protocols lists more than 4 entries")
	}
	for _, p := range m.Protocols {
		if err := match("protocols[]", reWSProtocol, p, 64); err != nil {
			return err
		}
	}
	return nil
}

func (m *WSOpened) validate() error {
	return first(streamID(m.StreamID), maxLen("protocol", m.Protocol, 64))
}

func (m *WSClose) validate() error {
	return first(streamID(m.StreamID), between("code", int64(m.Code), 1000, 4999), maxLen("reason", m.Reason, 123))
}

func (m *Window) validate() error {
	return first(streamID(m.StreamID), between("credit", m.Credit, 1, 16777216))
}

func (m *StreamReset) validate() error {
	return first(streamID(m.StreamID), m.Code.check("code"), detail(m.Detail))
}

func (m *Heartbeat) validate() error {
	if err := first(between("seq", m.Seq, 0, 9007199254740991), unixSeconds("ts", m.TS)); err != nil {
		return err
	}
	if len(m.Sessions) > 64 {
		return fmt.Errorf("sessions lists more than 64 sessions")
	}
	for _, s := range m.Sessions {
		if err := first(
			uuid("sessions[].sessionId", s.SessionID),
			oneOf("sessions[].state", s.State, sessionStates...),
			optional(s.Phase, func() error { return oneOf("sessions[].phase", s.Phase, "attached", "detached") }),
			optional(s.Cause, func() error { return oneOf("sessions[].cause", s.Cause, causes...) }),
			optional(s.LeaseExpiresAt, func() error { return timestamp("sessions[].leaseExpiresAt", s.LeaseExpiresAt) }),
		); err != nil {
			return err
		}
		if len(s.Kernels) > 16 {
			return fmt.Errorf("sessions[].kernels lists more than 16 kernels")
		}
		for _, k := range s.Kernels {
			if err := first(
				match("kernels[].id", reKernelID, k.ID, 0),
				oneOf("kernels[].executionState", k.ExecutionState, "starting", "idle", "busy", "unknown"),
				optional(k.LastActivity, func() error { return timestamp("kernels[].lastActivity", k.LastActivity) }),
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *HeartbeatAck) validate() error { return between("seq", m.Seq, 0, 9007199254740991) }

func (m *Error) validate() error {
	return first(
		optional(m.RequestID, func() error { return uuid("requestId", m.RequestID) }),
		optional(m.SessionID, func() error { return uuid("sessionId", m.SessionID) }),
		m.Code.check("code"),
		detail(m.Detail),
	)
}
