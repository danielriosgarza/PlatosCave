package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"
)

// UnknownTypeError is a well-formed message whose `t` this connector does not know. The link
// answers it with `error unsupported_message` and carries on (design §4.1).
type UnknownTypeError struct {
	T string
}

func (e *UnknownTypeError) Error() string {
	return fmt.Sprintf("unknown message type %q", e.T)
}

// InvalidError is a message that is not valid JSON or fails its schema. On the link it ends the
// link with 4400 (design §4.1).
type InvalidError struct {
	T      string
	Reason string
}

func (e *InvalidError) Error() string {
	if e.T == "" {
		return "invalid message: " + e.Reason
	}
	return fmt.Sprintf("invalid %s message: %s", e.T, e.Reason)
}

// Decode parses one control message and checks it against link.schema.json. It returns an
// *UnknownTypeError for a well-formed envelope with an unknown `t`, and an *InvalidError for
// anything else that is wrong. Use Sender to check the message came from the right side.
func Decode(text []byte) (Message, error) {
	if !utf8.Valid(text) {
		return nil, &InvalidError{Reason: "not UTF-8"}
	}
	if err := rejectNull(text); err != nil {
		return nil, &InvalidError{Reason: err.Error()}
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(text, &obj); err != nil || obj == nil {
		return nil, &InvalidError{Reason: "not a JSON object"}
	}
	var v int
	if raw, ok := obj["v"]; !ok || json.Unmarshal(raw, &v) != nil || v != Version {
		return nil, &InvalidError{Reason: fmt.Sprintf("v must be %d", Version)}
	}
	var t string
	if raw, ok := obj["t"]; !ok || json.Unmarshal(raw, &t) != nil {
		return nil, &InvalidError{Reason: "t must be a string"}
	}
	k, ok := kinds[t]
	if !ok {
		return nil, &UnknownTypeError{T: t}
	}
	delete(obj, "v")
	delete(obj, "t")
	body, err := json.Marshal(obj)
	if err != nil {
		return nil, &InvalidError{T: t, Reason: err.Error()}
	}
	m := k.new()
	if err := strictUnmarshal(body, m); err != nil {
		return nil, &InvalidError{T: t, Reason: err.Error()}
	}
	if err := m.validate(); err != nil {
		return nil, &InvalidError{T: t, Reason: err.Error()}
	}
	return m, nil
}

// Encode checks a message against link.schema.json and the error catalogue and returns its JSON
// text. A message that would not pass the other side's schema is never sent.
func Encode(m Message) ([]byte, error) {
	if err := m.validate(); err != nil {
		return nil, &InvalidError{T: m.Type(), Reason: err.Error()}
	}
	for _, c := range codesOf(m) {
		if !c.Known() {
			return nil, &InvalidError{T: m.Type(), Reason: fmt.Sprintf("code %q is not in errors.json", c)}
		}
	}
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	fmt.Fprintf(&buf, `{"v":%d,"t":%q`, Version, m.Type())
	if len(body) > 2 {
		buf.WriteByte(',')
		buf.Write(body[1:])
	} else {
		buf.WriteByte('}')
	}
	out := buf.Bytes()
	if err := rejectNull(out); err != nil {
		return nil, &InvalidError{T: m.Type(), Reason: err.Error() + " (a required list or object is nil)"}
	}
	return out, nil
}

// codesOf lists the catalogue codes a message carries.
func codesOf(m Message) []Code {
	var out []Code
	add := func(c Code) {
		if c != "" {
			out = append(out, c)
		}
	}
	switch m := m.(type) {
	case *Error:
		add(m.Code)
	case *StreamReset:
		add(m.Code)
	case *SessionState:
		add(m.Code)
	case *TestProgress:
		add(m.Stage.Code)
	case *TestResult:
		for _, s := range m.Stages {
			add(s.Code)
		}
	}
	return out
}

// rejectNull fails on invalid JSON and on any null: no field of the protocol allows one.
func rejectNull(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	depth := 0
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			if depth != 0 {
				return errors.New("truncated JSON")
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("not valid JSON: %v", err)
		}
		switch tok {
		case nil:
			return errors.New("null is not allowed")
		case json.Delim('{'), json.Delim('['):
			depth++
		case json.Delim('}'), json.Delim(']'):
			depth--
			if depth == 0 && dec.More() {
				return errors.New("trailing data after the JSON value")
			}
		}
	}
}

// strictUnmarshal decodes one JSON value into v, refusing unknown or differently cased keys,
// missing required keys (fields whose json tag lacks omitempty) and trailing data.
func strictUnmarshal(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON value")
	}
	return checkKeys(data, reflect.TypeOf(v), "")
}

var unmarshalerType = reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()

// checkKeys walks a decoded value's type beside its JSON: every object key must be a field name
// exactly (encoding/json matches case-insensitively), and every required field must be present.
// Types with their own UnmarshalJSON check themselves.
func checkKeys(raw []byte, t reflect.Type, path string) error {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if reflect.PointerTo(t).Implements(unmarshalerType) {
		return nil
	}
	switch t.Kind() {
	case reflect.Struct:
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err != nil {
			return fmt.Errorf("%s: %v", where(path), err)
		}
		known := map[string]bool{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name, omitempty := jsonName(f)
			if name == "" {
				continue
			}
			known[name] = true
			val, ok := obj[name]
			if !ok {
				if !omitempty {
					return fmt.Errorf("%s: %s is required", where(path), name)
				}
				continue
			}
			// An optional field is omitted when empty, so a present empty value would be lost
			// on the way through; unless the schema allows it (tag zero:"ok"), it is refused.
			if omitempty && f.Type.Kind() != reflect.Pointer && f.Tag.Get("zero") != "ok" && isEmptyJSON(val, f.Type) {
				return fmt.Errorf("%s: %s must not be empty", where(path), name)
			}
			if err := checkKeys(val, f.Type, join(path, name)); err != nil {
				return err
			}
		}
		for _, k := range sortedKeys(obj) {
			if !known[k] {
				return fmt.Errorf("%s: unknown field %q", where(path), k)
			}
		}
	case reflect.Slice:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return fmt.Errorf("%s: %v", where(path), err)
		}
		for i, item := range items {
			if err := checkKeys(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

// isEmptyJSON reports whether raw decodes to the value omitempty would drop.
func isEmptyJSON(raw []byte, t reflect.Type) bool {
	v := reflect.New(t)
	if json.Unmarshal(raw, v.Interface()) != nil {
		return false
	}
	e := v.Elem()
	switch e.Kind() {
	case reflect.Slice, reflect.Map, reflect.String:
		return e.Len() == 0
	}
	return e.IsZero()
}

// allowKeys checks an object's keys against the fields one variant of a oneOf may have.
func allowKeys(raw []byte, path string, required []string, optional ...string) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return fmt.Errorf("%s: %v", where(path), err)
	}
	allowed := map[string]bool{}
	for _, k := range required {
		allowed[k] = true
		if _, ok := obj[k]; !ok {
			return fmt.Errorf("%s: %s is required", where(path), k)
		}
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for _, k := range sortedKeys(obj) {
		if !allowed[k] {
			return fmt.Errorf("%s: unknown field %q", where(path), k)
		}
	}
	return nil
}

func jsonName(f reflect.StructField) (string, bool) {
	tag := f.Tag.Get("json")
	if tag == "-" || !f.IsExported() {
		return "", false
	}
	name, opts, _ := strings.Cut(tag, ",")
	if name == "" {
		name = f.Name
	}
	return name, strings.Contains(","+opts+",", ",omitempty,")
}

func sortedKeys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func where(path string) string {
	if path == "" {
		return "message"
	}
	return path
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

// Headers are HTTP headers with lower-case names. A nil map encodes as {}.
type Headers map[string]string

// MarshalJSON encodes nil as an empty object, since `headers` is required.
func (h Headers) MarshalJSON() ([]byte, error) {
	if h == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(map[string]string(h))
}

// AuthRef is a reference to SSH credentials on the connector's computer; never a secret.
type AuthRef struct {
	Method  string `json:"method"`
	KeyPath string `json:"keyPath,omitempty"`
	Hint    string `json:"hint,omitempty" zero:"ok"`
	KeyID   string `json:"keyId,omitempty"`
}

// Auth methods.
const (
	AuthKey        = "key"
	AuthAgent      = "agent"
	AuthManagedKey = "managed_key"
)

// UnmarshalJSON accepts exactly one variant of the schema's `auth` oneOf.
func (a *AuthRef) UnmarshalJSON(data []byte) error {
	type plain AuthRef
	var p plain
	if err := strictUnmarshal(data, &p); err != nil {
		return err
	}
	var err error
	switch p.Method {
	case AuthKey:
		err = allowKeys(data, "auth", []string{"method", "keyPath"})
	case AuthAgent:
		err = allowKeys(data, "auth", []string{"method"}, "hint")
	case AuthManagedKey:
		err = allowKeys(data, "auth", []string{"method", "keyId"})
	default:
		err = fmt.Errorf("auth: unknown method %q", p.Method)
	}
	if err != nil {
		return err
	}
	*a = AuthRef(p)
	return nil
}

// Target is where code runs: one of the schema's three shapes, told apart by Kind.
type Target struct {
	Kind string `json:"kind"`
	// local and ssh
	Workspace string `json:"workspace,omitempty"`
	// ssh
	Host        string    `json:"host,omitempty"`
	Port        int       `json:"port,omitempty"`
	User        string    `json:"user,omitempty"`
	Auth        *AuthRef  `json:"auth,omitempty"`
	Jump        *Hop      `json:"jump,omitempty"`
	HostKeys    []HostKey `json:"hostKeys,omitempty" zero:"ok"`
	ExpectedEnd string    `json:"expectedEnd,omitempty"`
	// managed
	TargetID string `json:"targetId,omitempty"`
	Subject  string `json:"subject,omitempty"`
}

// Target kinds.
const (
	TargetLocal   = "local"
	TargetSSH     = "ssh"
	TargetManaged = "managed"
)

// UnmarshalJSON accepts exactly one variant of the schema's `target` oneOf.
func (t *Target) UnmarshalJSON(data []byte) error {
	type plain Target
	var p plain
	if err := strictUnmarshal(data, &p); err != nil {
		return err
	}
	var err error
	switch p.Kind {
	case TargetLocal:
		err = allowKeys(data, "target", []string{"kind", "workspace"})
	case TargetSSH:
		err = allowKeys(data, "target", []string{"kind", "host", "port", "user", "auth", "workspace"},
			"jump", "hostKeys", "expectedEnd")
	case TargetManaged:
		err = allowKeys(data, "target", []string{"kind", "targetId", "subject"})
	default:
		err = fmt.Errorf("target: unknown kind %q", p.Kind)
	}
	if err != nil {
		return err
	}
	*t = Target(p)
	return nil
}

// Runtime says whether to start Jupyter or attach to a running one.
type Runtime struct {
	Mode string `json:"mode"`
	// start
	Python string `json:"python,omitempty"`
	Login  *bool  `json:"login,omitempty"`
	// attach
	Port int   `json:"port,omitempty"`
	PID  int64 `json:"pid,omitempty"`
	// both
	KernelName string `json:"kernelName,omitempty"`
}

// Runtime modes.
const (
	RuntimeStart  = "start"
	RuntimeAttach = "attach"
)

// UnmarshalJSON accepts exactly one variant of the schema's `runtime` oneOf.
func (r *Runtime) UnmarshalJSON(data []byte) error {
	type plain Runtime
	var p plain
	if err := strictUnmarshal(data, &p); err != nil {
		return err
	}
	var err error
	switch p.Mode {
	case RuntimeStart:
		err = allowKeys(data, "runtime", []string{"mode"}, "python", "login", "kernelName")
	case RuntimeAttach:
		err = allowKeys(data, "runtime", []string{"mode", "port"}, "pid", "kernelName")
	default:
		err = fmt.Errorf("runtime: unknown mode %q", p.Mode)
	}
	if err != nil {
		return err
	}
	*r = Runtime(p)
	return nil
}
