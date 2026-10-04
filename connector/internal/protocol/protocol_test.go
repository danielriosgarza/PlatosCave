package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/netip"
	pathpkg "path"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"parallax/connector/protocol"
)

const schemaBase = "https://parallax.invalid/connector/v1/"

// compileSchemas loads the three embedded schemas into one compiler.
func compileSchemas(t *testing.T) *jsonschema.Compiler {
	t.Helper()
	c := jsonschema.NewCompiler()
	for _, name := range []string{"link.schema.json", "pairing.schema.json", "state.schema.json"} {
		data, err := protocol.V1.ReadFile("v1/" + name)
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := c.AddResource(schemaBase+name, doc); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	return c
}

// fixture is one file of examples/, examples/invalid/ or examples/rejected/.
type fixture struct {
	dir, name string
	data      []byte
}

func fixtures(t *testing.T, dir string) []fixture {
	t.Helper()
	entries, err := fs.ReadDir(protocol.V1, pathpkg.Join("v1/examples", dir))
	if err != nil {
		t.Fatal(err)
	}
	var out []fixture
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := protocol.V1.ReadFile(pathpkg.Join("v1/examples", dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, fixture{dir: dir, name: strings.TrimSuffix(e.Name(), ".json"), data: data})
	}
	if len(out) == 0 {
		t.Fatalf("no fixtures in examples/%s", dir)
	}
	return out
}

// schemasFor returns the schema locations a fixture's prefix selects (design §4).
func schemasFor(t *testing.T, name string) []string {
	t.Helper()
	prefix, rest, _ := strings.Cut(name, "-")
	def, _, _ := strings.Cut(rest, "-")
	switch prefix {
	case "s2c":
		return []string{schemaBase + "link.schema.json#/$defs/ServerMessage"}
	case "c2s":
		return []string{schemaBase + "link.schema.json#/$defs/ConnectorMessage"}
	case "both":
		return []string{schemaBase + "link.schema.json#/$defs/ServerMessage", schemaBase + "link.schema.json#/$defs/ConnectorMessage"}
	case "pairing", "state":
		return []string{schemaBase + prefix + ".schema.json#/$defs/" + def}
	}
	t.Fatalf("fixture %s has no known prefix", name)
	return nil
}

func validateWith(t *testing.T, c *jsonschema.Compiler, loc string, data []byte) error {
	t.Helper()
	sch, err := c.Compile(loc)
	if err != nil {
		t.Fatalf("compile %s: %v", loc, err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		return err
	}
	return sch.Validate(inst)
}

func isLink(name string) bool {
	p, _, _ := strings.Cut(name, "-")
	return p == "s2c" || p == "c2s" || p == "both"
}

// rejectedRules is the table of design §4.4: the rule each file of examples/rejected/ breaks.
var rejectedRules = map[string]int{
	"s2c-test_connection-host-decimal-ip":               1,
	"s2c-test_connection-host-hex-ip":                   1,
	"s2c-test_connection-host-hex-ip-upper":             1,
	"s2c-test_connection-host-short-ipv4":               1,
	"s2c-test_connection-host-metadata-ip":              2,
	"s2c-test_connection-host-mapped-metadata":          2,
	"s2c-test_connection-host-link-local-v6":            2,
	"s2c-test_connection-workspace-relative":            3,
	"s2c-test_connection-workspace-dotdot":              3,
	"s2c-test_connection-keypath-relative":              4,
	"s2c-open_session-python-dotdot":                    5,
	"s2c-open_session-login-on-local":                   5,
	"s2c-test_connection-hostkeys-duplicate":            6,
	"s2c-test_connection-confirmation-replacing-itself": 7,
	"s2c-test_connection-jump-is-target":                8,
}

// TestSchemaFixtures validates every example against the schema its prefix selects: examples/
// must pass, examples/invalid/ must fail, and examples/rejected/ must pass the schema and fail
// ValidateTarget on exactly the rule of design §4.4. The connector's own decoder must agree with
// the schema on every link fixture.
func TestSchemaFixtures(t *testing.T) {
	c := compileSchemas(t)

	t.Run("valid", func(t *testing.T) {
		for _, f := range fixtures(t, "") {
			for _, loc := range schemasFor(t, f.name) {
				if err := validateWith(t, c, loc, f.data); err != nil {
					t.Errorf("%s fails %s: %v", f.name, loc, err)
				}
			}
			if !isLink(f.name) {
				continue
			}
			m, err := Decode(f.data)
			if err != nil {
				t.Errorf("%s: Decode: %v", f.name, err)
				continue
			}
			dir, _ := Sender(m.Type())
			want := map[string]Direction{"s2c": FromServer, "c2s": FromConnector, "both": Both}[strings.SplitN(f.name, "-", 2)[0]]
			if dir&want != want {
				t.Errorf("%s: %s is sent by %v, the prefix says %v", f.name, m.Type(), dir, want)
			}
			if err := ValidateRequest(m); err != nil {
				t.Errorf("%s: ValidateRequest: %v", f.name, err)
			}
		}
	})

	t.Run("invalid", func(t *testing.T) {
		for _, f := range fixtures(t, "invalid") {
			for _, loc := range schemasFor(t, f.name) {
				if err := validateWith(t, c, loc, f.data); err == nil {
					t.Errorf("%s passes %s; it must fail", f.name, loc)
				}
			}
			if isLink(f.name) {
				m, err := Decode(f.data)
				var inv *InvalidError
				if !errors.As(err, &inv) {
					t.Errorf("%s: Decode accepted it as %T (err %v); it must be invalid", f.name, m, err)
				}
			}
		}
	})

	t.Run("rejected", func(t *testing.T) {
		seen := map[string]bool{}
		for _, f := range fixtures(t, "rejected") {
			seen[f.name] = true
			want, ok := rejectedRules[f.name]
			if !ok {
				t.Errorf("%s is not in the table of design §4.4", f.name)
				continue
			}
			for _, loc := range schemasFor(t, f.name) {
				if err := validateWith(t, c, loc, f.data); err != nil {
					t.Errorf("%s fails %s: %v; it must pass the schema", f.name, loc, err)
				}
			}
			m, err := Decode(f.data)
			if err != nil {
				t.Errorf("%s: Decode: %v", f.name, err)
				continue
			}
			var rules []int
			switch m := m.(type) {
			case *TestConnection:
				for _, v := range TargetViolations(m.Target, m.Runtime, m.Confirmations) {
					rules = append(rules, v.Rule)
				}
			case *OpenSession:
				for _, v := range TargetViolations(m.Target, m.Runtime, nil) {
					rules = append(rules, v.Rule)
				}
			default:
				t.Errorf("%s: %T carries no target", f.name, m)
				continue
			}
			if len(rules) == 0 {
				t.Errorf("%s passes ValidateTarget; it must break rule %d", f.name, want)
				continue
			}
			for _, r := range rules {
				if r != want {
					t.Errorf("%s breaks rules %v; it must break only rule %d", f.name, rules, want)
					break
				}
			}
			var te *TargetError
			if err := ValidateRequest(m); !errors.As(err, &te) || te.Rule != want {
				t.Errorf("%s: ValidateRequest = %v, want rule %d", f.name, err, want)
			}
		}
		for name := range rejectedRules {
			if !seen[name] {
				t.Errorf("%s is in the table but not in examples/rejected/", name)
			}
		}
	})
}

// TestEncodeRoundTrip decodes every valid link fixture, encodes it and compares the JSON values.
func TestEncodeRoundTrip(t *testing.T) {
	for _, f := range fixtures(t, "") {
		if !isLink(f.name) {
			continue
		}
		m, err := Decode(f.data)
		if err != nil {
			t.Fatalf("%s: %v", f.name, err)
		}
		out, err := Encode(m)
		if err != nil {
			t.Errorf("%s: Encode: %v", f.name, err)
			continue
		}
		var a, b any
		if err := json.Unmarshal(f.data, &a); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(out, &b); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s: round trip changed the message\n got %s", f.name, out)
		}
	}
}

// TestDecodeRefusals covers what the fixtures do not: wrong envelopes, nulls, case-folded and
// unknown keys, empty optional values and unknown types.
func TestDecodeRefusals(t *testing.T) {
	invalid := map[string]string{
		"not JSON":              `{"v":1,"t":"activity"`,
		"not an object":         `[1]`,
		"no v":                  `{"t":"heartbeat_ack","seq":1}`,
		"v as string":           `{"v":"1","t":"heartbeat_ack","seq":1}`,
		"no t":                  `{"v":1,"seq":1}`,
		"t not a string":        `{"v":1,"t":7,"seq":1}`,
		"null":                  `{"v":1,"t":"error","code":"internal","detail":null}`,
		"case-folded key":       `{"v":1,"t":"heartbeat_ack","Seq":1}`,
		"extra key":             `{"v":1,"t":"heartbeat_ack","seq":1,"x":1}`,
		"missing key":           `{"v":1,"t":"window","streamId":1}`,
		"trailing data":         `{"v":1,"t":"heartbeat_ack","seq":1} {}`,
		"empty optional uuid":   `{"v":1,"t":"error","code":"internal","requestId":""}`,
		"zero optional stream":  `{"v":1,"t":"error","code":"internal","streamId":0}`,
		"stream id over 32 bit": `{"v":1,"t":"window","streamId":4294967296,"credit":1}`,
		"negative seq":          `{"v":1,"t":"heartbeat_ack","seq":-1}`,
		"fractional seq":        `{"v":1,"t":"heartbeat_ack","seq":1.5}`,
		"target key of another kind": `{"v":1,"t":"open_session","requestId":"c0ffee00-1111-4222-8333-444455556666",` +
			`"sessionId":"7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f","target":{"kind":"local","workspace":"/w","port":22},` +
			`"runtime":{"mode":"start"},"lease":{"idleTimeoutMin":30,"gracePeriodMin":5}}`,
		"empty hops": `{"v":1,"t":"test_progress","requestId":"c0ffee00-1111-4222-8333-444455556666",` +
			`"stage":{"name":"host_identity","status":"ok","data":{"hops":[]}}}`,
	}
	for name, text := range invalid {
		_, err := Decode([]byte(text))
		var inv *InvalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: Decode = %v, want an InvalidError", name, err)
		}
	}
	_, err := Decode([]byte(`{"v":1,"t":"ping","anything":true}`))
	var unk *UnknownTypeError
	if !errors.As(err, &unk) || unk.T != "ping" {
		t.Errorf("unknown type: Decode = %v, want UnknownTypeError for ping", err)
	}
	if _, err := Decode([]byte(`{"v":1,"t":"error","code":"internal","detail":""}`)); err != nil {
		t.Errorf("an empty detail is allowed: %v", err)
	}
}

func TestEncodeRefusesWhatTheServerWouldReject(t *testing.T) {
	cases := map[string]Message{
		"unknown code":       &Error{Code: "not_in_catalogue"},
		"nil required list":  &Heartbeat{Seq: 0, TS: 1},
		"running in result":  &TestResult{RequestID: "c0ffee00-1111-4222-8333-444455556666", Outcome: "failed", Stages: []Stage{{Name: "reachability", Status: "running"}}},
		"stream id zero":     &Window{StreamID: 0, Credit: 1},
		"detail with escape": &Error{Code: CodeInternal, Detail: "a\x1bb"},
	}
	for name, m := range cases {
		if _, err := Encode(m); err == nil {
			t.Errorf("%s: Encode accepted it", name)
		}
	}
	out, err := Encode(&Heartbeat{Seq: 0, TS: 1, Sessions: []HeartbeatSession{}})
	if err != nil || string(out) != `{"v":1,"t":"heartbeat","seq":0,"ts":1,"sessions":[]}` {
		t.Errorf("heartbeat: %s, %v", out, err)
	}
	out, err = Encode(&HTTPHead{StreamID: 3, Status: 200, Body: "none"})
	if err != nil || !strings.Contains(string(out), `"headers":{}`) {
		t.Errorf("nil headers must encode as {}: %s, %v", out, err)
	}
}

type frameVector struct {
	Name        string `json:"name"`
	Hex         string `json:"hex"`
	StreamID    uint32 `json:"streamId"`
	Flags       byte   `json:"flags"`
	PayloadText string `json:"payloadText"`
	PayloadHex  string `json:"payloadHex"`
	Repeat      *struct {
		Byte  string `json:"byte"`
		Count int    `json:"count"`
	} `json:"repeat"`
	Rule string `json:"rule"`
}

func (v frameVector) bytes(t *testing.T) []byte {
	t.Helper()
	if v.Hex != "" {
		b, err := hex.DecodeString(v.Hex)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	b, err := hex.DecodeString(v.Repeat.Byte)
	if err != nil || len(b) != 1 {
		t.Fatalf("%s: repeat byte %q", v.Name, v.Repeat.Byte)
	}
	out := []byte{byte(v.StreamID >> 24), byte(v.StreamID >> 16), byte(v.StreamID >> 8), byte(v.StreamID), v.Flags}
	return append(out, bytes.Repeat(b, v.Repeat.Count)...)
}

func (v frameVector) payload(t *testing.T) []byte {
	t.Helper()
	switch {
	case v.Repeat != nil:
		b, _ := hex.DecodeString(v.Repeat.Byte)
		return bytes.Repeat(b, v.Repeat.Count)
	case v.PayloadHex != "":
		b, err := hex.DecodeString(v.PayloadHex)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	return []byte(v.PayloadText)
}

// TestFrameVectors decodes and encodes every vector of vectors/frames.json.
func TestFrameVectors(t *testing.T) {
	data, err := protocol.V1.ReadFile("v1/vectors/frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		MaxPayload int           `json:"maxPayload"`
		Valid      []frameVector `json:"valid"`
		Invalid    []frameVector `json:"invalid"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.MaxPayload != DefaultMaxPayload {
		t.Fatalf("maxPayload %d, DefaultMaxPayload %d", file.MaxPayload, DefaultMaxPayload)
	}
	for _, v := range file.Valid {
		raw := v.bytes(t)
		f, err := DecodeFrame(raw, file.MaxPayload)
		if err != nil {
			t.Errorf("%s: %v", v.Name, err)
			continue
		}
		if f.StreamID != v.StreamID || f.Flags != v.Flags || !bytes.Equal(f.Payload, v.payload(t)) {
			t.Errorf("%s: decoded %v", v.Name, f)
		}
		enc, err := EncodeFrame(Frame{StreamID: v.StreamID, Flags: v.Flags, Payload: v.payload(t)}, file.MaxPayload)
		if err != nil || !bytes.Equal(enc, raw) {
			t.Errorf("%s: encoded %x, %v", v.Name, enc, err)
		}
	}
	for _, v := range file.Invalid {
		_, err := DecodeFrame(v.bytes(t), file.MaxPayload)
		var fe *FrameError
		if !errors.As(err, &fe) || fe.Rule != v.Rule {
			t.Errorf("%s: DecodeFrame = %v, want rule %s", v.Name, err, v.Rule)
		}
		if v.Repeat != nil || len(v.bytes(t)) >= FrameHeaderSize {
			f := Frame{StreamID: v.StreamID, Flags: v.Flags, Payload: v.payload(t)}
			if v.Hex != "" {
				raw := v.bytes(t)
				f = Frame{StreamID: uint32(raw[0])<<24 | uint32(raw[1])<<16 | uint32(raw[2])<<8 | uint32(raw[3]), Flags: raw[4], Payload: raw[5:]}
			}
			if _, err := EncodeFrame(f, file.MaxPayload); !errors.As(err, &fe) || fe.Rule != v.Rule {
				t.Errorf("%s: EncodeFrame = %v, want rule %s", v.Name, err, v.Rule)
			}
		}
	}
}

// TestErrorCodesInCatalogue checks the code constants against errors.json both ways and that the
// catalogue is consistent: every stage is a stage name, every cause and recovery is declared.
func TestErrorCodesInCatalogue(t *testing.T) {
	cat, err := LoadCatalogue()
	if err != nil {
		t.Fatal(err)
	}
	var fromFile, fromGo []string
	for c := range cat.Codes {
		fromFile = append(fromFile, string(c))
	}
	for _, c := range Codes {
		fromGo = append(fromGo, string(c))
		if !c.Known() {
			t.Errorf("code %s is not in errors.json", c)
		}
		if err := c.check("code"); err != nil {
			t.Errorf("code %s does not match the schema's code pattern: %v", c, err)
		}
	}
	sort.Strings(fromFile)
	sort.Strings(fromGo)
	if !reflect.DeepEqual(fromFile, fromGo) {
		t.Errorf("code constants differ from errors.json\nfile: %v\n  go: %v", fromFile, fromGo)
	}
	recoveries := map[string]bool{}
	for _, r := range cat.Recoveries {
		recoveries[r] = true
	}
	for c, e := range cat.Codes {
		if e.Stage != nil {
			if err := oneOf("stage", *e.Stage, stageNames...); err != nil {
				t.Errorf("%s: %v", c, err)
			}
		}
		if _, ok := cat.Causes[e.Cause]; !ok {
			t.Errorf("%s: cause %q is not declared", c, e.Cause)
		}
		for _, r := range e.Recoveries {
			if !recoveries[r] {
				t.Errorf("%s: recovery %q is not declared", c, r)
			}
		}
	}
	for _, cause := range causes {
		if _, ok := cat.Loss[cause]; !ok {
			t.Errorf("session cause %q has no entry in errors.json loss", cause)
		}
	}
}

func TestHostSyntaxAndLiterals(t *testing.T) {
	good := []string{"gpu01.lab.example.org", "localhost", "10.0.0.1", "0.0.0.1", "a-b.c", "2001:db8::1", "x1.y2", "a.b1c"}
	bad := []string{"2852039166", "0x7f000001", "0X7F000001", "127.1", "010.0.0.1", "256.1.1.1", "1.2.3.4.5",
		"-a.b", "a-.b", "a..b", "a.", ".a", "a.0x1f", "fe80::1%eth0", "1.2.3", "a.123"}
	for _, h := range good {
		if err := CheckHostSyntax(h); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
	for _, h := range bad {
		if err := CheckHostSyntax(h); err == nil {
			t.Errorf("%s: accepted", h)
		}
	}
	forbidden := []string{"0.0.0.0", "::", "169.254.169.254", "fe80::1", "224.0.0.1", "ff02::1", "255.255.255.255",
		"::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "::ffff:0.0.0.0"}
	for _, h := range forbidden {
		a, ok := hostLiteral(h)
		if !ok || forbiddenLiteral(a) == "" {
			t.Errorf("%s: not forbidden", h)
		}
	}
	for _, h := range []string{"10.0.0.1", "8.8.8.8", "2001:db8::1", "127.0.0.1", "::1"} {
		a, _ := hostLiteral(h)
		if why := forbiddenLiteral(a); why != "" {
			t.Errorf("%s: forbidden as %s; rule 2 leaves it to the network scope", h, why)
		}
	}
	if got := Unwrap(netip.MustParseAddr("2002:c000:0201::1")); got != netip.MustParseAddr("192.0.2.1") {
		t.Errorf("6to4 unwrap: %v", got)
	}
}

func TestTargetRulesOnWindowsPaths(t *testing.T) {
	local := Target{Kind: TargetLocal, Workspace: `C:\Users\student\parallax`}
	if err := ValidateTarget(local, Runtime{Mode: RuntimeStart, Python: `C:/Python312/python.exe`}, nil); err != nil {
		t.Errorf("drive-rooted local workspace and python: %v", err)
	}
	if err := ValidateTarget(Target{Kind: TargetLocal, Workspace: `C:\a\..\b`}, Runtime{Mode: RuntimeStart}, nil); err == nil {
		t.Error(`C:\a\..\b accepted`)
	}
	ssh := Target{Kind: TargetSSH, Host: "h.example.org", Port: 22, User: "u", Auth: &AuthRef{Method: AuthKey, KeyPath: `C:\keys\id`}, Workspace: `C:\w`}
	var te *TargetError
	if err := ValidateTarget(ssh, Runtime{Mode: RuntimeStart}, nil); !errors.As(err, &te) || te.Rule != 3 {
		t.Errorf("an ssh workspace must start with /: %v", err)
	}
	ssh.Workspace = "/w"
	if err := ValidateTarget(ssh, Runtime{Mode: RuntimeStart}, nil); err != nil {
		t.Errorf("a drive-rooted key path on the connector's computer is allowed: %v", err)
	}
	confirm := []Confirmation{{Host: "other.example.org", Port: 22, SHA256: "SHA256:SGuN8fwGXFkUlKZT8ILLvpynWOsg9Y72LtxX1LmpqEM"}}
	if err := ValidateTarget(ssh, Runtime{Mode: RuntimeStart}, confirm); !errors.As(err, &te) || te.Rule != 7 {
		t.Errorf("a confirmation for another host: %v", err)
	}
}
