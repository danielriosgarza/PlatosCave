package managed

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"

	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// SubjectPlaceholder stands for the learner's subject (a UUID) in an account or workspace rule.
const SubjectPlaceholder = "{subject}"

// maxTargetsFile and maxTargets bound PARALLAX_TARGETS_FILE.
const (
	maxTargetsFile = 1 << 20
	maxTargets     = 256
)

var reID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func validID(s string) bool { return reID.MatchString(s) }

// sampleSubject checks the rules of each entry when the file is loaded.
const sampleSubject = "00000000-0000-4000-8000-000000000000"

// sampleRequest is the request id of the check message built for each entry.
const sampleRequest = "00000000-0000-4000-8000-000000000001"

// File is PARALLAX_TARGETS_FILE: the targets an operator offers, by targetId.
//
//	{"v": 1, "targets": {"hpc-login": {"host": "login.hpc.example.org", "port": 22,
//	  "user": "p-{subject}", "keyId": "hpc", "workspace": "/scratch/parallax/{subject}",
//	  "jump": {"host": "bastion.example.org", "port": 22, "user": "parallax"},
//	  "runtime": {"python": "/opt/conda/bin/python"}}}}
type File struct {
	V       int              `json:"v"`
	Targets map[string]Entry `json:"targets"`
}

// Entry is one target. User (the account rule) and Workspace (the workspace rule) may contain
// {subject}, replaced by the learner's subject; nothing else in a request reaches the target.
type Entry struct {
	Host      string     `json:"host"`
	Port      int        `json:"port"`
	User      string     `json:"user"`
	KeyID     string     `json:"keyId"`
	Workspace string     `json:"workspace"`
	Jump      *JumpEntry `json:"jump,omitempty"`
	Runtime   Runtime    `json:"runtime"`
}

// JumpEntry is a target's jump host; its key is the target's unless it names its own.
type JumpEntry struct {
	Host  string `json:"host"`
	Port  int    `json:"port"`
	User  string `json:"user"`
	KeyID string `json:"keyId,omitempty"`
}

// Runtime is how Jupyter starts on a target. A managed target always starts its own server:
// attaching would let a learner reach a server someone else started on a shared host.
type Runtime struct {
	Python string `json:"python,omitempty"`
	Login  *bool  `json:"login,omitempty"`
}

// Targets is the parsed, checked PARALLAX_TARGETS_FILE.
type Targets struct {
	entries map[string]Entry
}

// IDs returns the target ids in order.
func (t *Targets) IDs() []string {
	ids := make([]string, 0, len(t.entries))
	for id := range t.entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ParseTargets reads the targets file and checks every entry against the protocol's target rules,
// the scope (no loopback, link-local or other never-reachable literal; only allowed ports) and
// the key store (every key present with tight permissions), so a mistake stops the connector at
// start-up rather than at a learner's first test.
func ParseTargets(data []byte, scope netscope.Scope, keys *Keys) (*Targets, error) {
	if len(data) > maxTargetsFile {
		return nil, fmt.Errorf("the file is larger than %d bytes", maxTargetsFile)
	}
	var f File
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("not a targets file: %v", err)
	}
	if dec.More() {
		return nil, errors.New("not a targets file: more than one JSON value")
	}
	if f.V != 1 {
		return nil, fmt.Errorf("v must be 1, got %d", f.V)
	}
	if len(f.Targets) == 0 {
		return nil, errors.New("targets lists no target")
	}
	if len(f.Targets) > maxTargets {
		return nil, fmt.Errorf("at most %d targets", maxTargets)
	}
	t := &Targets{entries: f.Targets}
	for _, id := range t.IDs() {
		if err := t.check(id, scope, keys); err != nil {
			return nil, fmt.Errorf("target %q: %v", id, err)
		}
	}
	return t, nil
}

func (t *Targets) check(id string, scope netscope.Scope, keys *Keys) error {
	if !validID(id) {
		return errors.New("a target id is 1–63 characters of a-z, 0-9 and -, starting with a letter or digit")
	}
	e := t.entries[id]
	for _, rule := range []struct{ field, value string }{
		{"host", e.Host}, {"keyId", e.KeyID}, {"runtime.python", e.Runtime.Python},
	} {
		if strings.Contains(rule.value, "{") || strings.Contains(rule.value, "}") {
			return fmt.Errorf("%s may not contain a placeholder", rule.field)
		}
	}
	for _, rule := range []struct{ field, value string }{{"user", e.User}, {"workspace", e.Workspace}} {
		if rest := strings.ReplaceAll(rule.value, SubjectPlaceholder, ""); strings.ContainsAny(rest, "{}") {
			return fmt.Errorf("%s may contain only the placeholder %s", rule.field, SubjectPlaceholder)
		}
	}
	if e.Jump != nil && strings.ContainsAny(e.Jump.Host+e.Jump.KeyID+e.Jump.User, "{}") {
		return errors.New("jump may not contain a placeholder")
	}
	tg, rt := t.build(e, sampleSubject, "")
	if _, err := protocol.Encode(&protocol.TestConnection{RequestID: sampleRequest, Target: tg, Runtime: rt}); err != nil {
		return err
	}
	if err := protocol.ValidateTarget(tg, rt, nil); err != nil {
		return err
	}
	hosts := [][3]any{{"host", e.Host, e.Port}}
	if e.Jump != nil {
		hosts = append(hosts, [3]any{"jump.host", e.Jump.Host, e.Jump.Port})
	}
	for _, h := range hosts {
		field, host, port := h[0].(string), h[1].(string), h[2].(int)
		if a, err := netip.ParseAddr(host); err == nil {
			switch netscope.Classify(a) {
			case netscope.Loopback, netscope.HardDenied:
				return fmt.Errorf("%s %s is a loopback, link-local or otherwise never-reachable address", field, host)
			}
			if ok, why := scope.Allows(a); !ok {
				return fmt.Errorf("%s %s %s", field, host, why)
			}
		}
		if !scope.AllowsPort(port) {
			return fmt.Errorf("%s port %d is not in %s", field, port, netscope.EnvAllowPorts)
		}
	}
	if e.Jump != nil {
		// The jump host dials the target, so the connector can judge only what it names.
		if ok, why := scope.AllowsOnward(e.Host); !ok {
			return fmt.Errorf("host behind the jump host: %s", why)
		}
	}
	ids := []string{e.KeyID}
	if e.Jump != nil && e.Jump.KeyID != "" {
		ids = append(ids, e.Jump.KeyID)
	}
	for _, k := range ids {
		if err := keys.Check(k); err != nil {
			return fmt.Errorf("key %s: %v", k, err)
		}
	}
	return nil
}

// build is the `ssh` target and the runtime an entry gives a subject.
func (t *Targets) build(e Entry, subject, kernelName string) (protocol.Target, protocol.Runtime) {
	sub := func(s string) string { return strings.ReplaceAll(s, SubjectPlaceholder, subject) }
	tg := protocol.Target{
		Kind:      protocol.TargetSSH,
		Host:      e.Host,
		Port:      e.Port,
		User:      sub(e.User),
		Auth:      &protocol.AuthRef{Method: protocol.AuthManagedKey, KeyID: e.KeyID},
		Workspace: sub(e.Workspace),
	}
	if j := e.Jump; j != nil {
		tg.Jump = &protocol.Hop{Host: j.Host, Port: j.Port, User: j.User}
		if j.KeyID != "" {
			tg.Jump.Auth = &protocol.AuthRef{Method: protocol.AuthManagedKey, KeyID: j.KeyID}
		}
	}
	rt := protocol.Runtime{Mode: protocol.RuntimeStart, Python: e.Runtime.Python, Login: e.Runtime.Login, KernelName: kernelName}
	return tg, rt
}

// Resolve turns a request's `managed` target into the `ssh` target the operator configured for
// its targetId and subject, with the operator's runtime and the kernel the request chose. A
// target id the file does not hold is invalid_target; a request to attach is unsupported_target.
func (t *Targets) Resolve(req protocol.Target, rt protocol.Runtime) (protocol.Target, protocol.Runtime, error) {
	if req.Kind != protocol.TargetManaged {
		return protocol.Target{}, protocol.Runtime{}, &target.Failure{Code: protocol.CodeUnsupportedTarget,
			Detail: fmt.Sprintf("a managed connector serves only managed targets, not %s", req.Kind)}
	}
	e, ok := t.entries[req.TargetID]
	if !ok {
		return protocol.Target{}, protocol.Runtime{}, &target.Failure{Code: protocol.CodeInvalidTarget,
			Detail: fmt.Sprintf("this connector offers no target %q", req.TargetID)}
	}
	if !reSubject.MatchString(req.Subject) {
		return protocol.Target{}, protocol.Runtime{}, &target.Failure{Code: protocol.CodeInvalidTarget, Detail: "target.subject is not a UUID"}
	}
	if rt.Mode != protocol.RuntimeStart {
		return protocol.Target{}, protocol.Runtime{}, &target.Failure{Code: protocol.CodeUnsupportedTarget,
			Detail: "a managed target always starts its own Jupyter server; attaching is not offered"}
	}
	out, outRT := t.build(e, req.Subject, rt.KernelName)
	return out, outRT, nil
}

var reSubject = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
