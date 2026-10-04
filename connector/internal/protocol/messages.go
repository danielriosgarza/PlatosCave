// Package protocol is the connector's side of protocol v1 (docs/design/connector.md §4): a struct
// per control message of link.schema.json with a strict decoder and a validating encoder, the
// binary frame codec, the semantic target rules of §4.4 and the error catalogue. The binary does
// not link a JSON Schema validator; the checks here mirror the schema, and a test compares them
// with the schema over every fixture.
package protocol

// Version is the protocol major version carried in every message's `v`.
const Version = 1

// Subprotocol is the WebSocket subprotocol of the link.
const Subprotocol = "parallax.connector.v1"

// Message types: the `t` of every control message (design §4.3).
const (
	TChallenge      = "challenge"
	TAuth           = "auth"
	TAuthOK         = "auth_ok"
	THello          = "hello"
	TTestConnection = "test_connection"
	TTestProgress   = "test_progress"
	TTestResult     = "test_result"
	TOpenSession    = "open_session"
	TSessionState   = "session_state"
	TCloseSession   = "close_session"
	TPresence       = "presence"
	TActivity       = "activity"
	THTTP           = "http"
	THTTPHead       = "http_head"
	TWSOpen         = "ws_open"
	TWSOpened       = "ws_opened"
	TWSClose        = "ws_close"
	TWindow         = "window"
	TStreamReset    = "stream_reset"
	THeartbeat      = "heartbeat"
	THeartbeatAck   = "heartbeat_ack"
	TError          = "error"
)

// Direction says which side may send a message type.
type Direction uint8

// Directions. A `both` message may be sent by either side.
const (
	FromServer Direction = 1 << iota
	FromConnector
	Both = FromServer | FromConnector
)

// Message is one control message. Type returns its `t`.
type Message interface {
	Type() string
	validate() error
}

type kind struct {
	dir Direction
	new func() Message
}

var kinds = map[string]kind{
	TChallenge:      {FromServer, func() Message { return new(Challenge) }},
	TAuth:           {FromConnector, func() Message { return new(Auth) }},
	TAuthOK:         {FromServer, func() Message { return new(AuthOK) }},
	THello:          {FromConnector, func() Message { return new(Hello) }},
	TTestConnection: {FromServer, func() Message { return new(TestConnection) }},
	TTestProgress:   {FromConnector, func() Message { return new(TestProgress) }},
	TTestResult:     {FromConnector, func() Message { return new(TestResult) }},
	TOpenSession:    {FromServer, func() Message { return new(OpenSession) }},
	TSessionState:   {FromConnector, func() Message { return new(SessionState) }},
	TCloseSession:   {FromServer, func() Message { return new(CloseSession) }},
	TPresence:       {FromServer, func() Message { return new(Presence) }},
	TActivity:       {FromServer, func() Message { return new(Activity) }},
	THTTP:           {FromServer, func() Message { return new(HTTP) }},
	THTTPHead:       {FromConnector, func() Message { return new(HTTPHead) }},
	TWSOpen:         {FromServer, func() Message { return new(WSOpen) }},
	TWSOpened:       {FromConnector, func() Message { return new(WSOpened) }},
	TWSClose:        {Both, func() Message { return new(WSClose) }},
	TWindow:         {Both, func() Message { return new(Window) }},
	TStreamReset:    {Both, func() Message { return new(StreamReset) }},
	THeartbeat:      {FromConnector, func() Message { return new(Heartbeat) }},
	THeartbeatAck:   {FromServer, func() Message { return new(HeartbeatAck) }},
	TError:          {Both, func() Message { return new(Error) }},
}

// Sender returns the sides that may send a message type, and false for an unknown type.
func Sender(t string) (Direction, bool) {
	k, ok := kinds[t]
	return k.dir, ok
}

// Challenge is the server's first message of a link.
type Challenge struct {
	Nonce  string `json:"nonce"`
	Origin string `json:"origin"`
	TS     int64  `json:"ts"`
}

// Auth answers Challenge with the link signature of design §4.2.
type Auth struct {
	ConnectorID string `json:"connectorId"`
	TS          int64  `json:"ts"`
	Sig         string `json:"sig"`
}

// Limits are the link limits the server sets in AuthOK.
type Limits struct {
	MaxStreams    int `json:"maxStreams"`
	MaxPayload    int `json:"maxPayload"`
	InitialWindow int `json:"initialWindow"`
	MaxControl    int `json:"maxControl"`
	MaxSessions   int `json:"maxSessions"`
}

// AuthOK accepts the link.
type AuthOK struct {
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
	Limits           Limits `json:"limits"`
	MinVersion       string `json:"minVersion,omitempty"`
}

// Features are what the connector's computer offers.
type Features struct {
	TTY   bool `json:"tty"`
	Agent bool `json:"agent"`
	WSL   bool `json:"wsl"`
}

// NetworkScope is what the connector may reach beyond public addresses (design §8).
type NetworkScope struct {
	CIDRs []string `json:"cidrs"`
	Hosts []string `json:"hosts"`
}

// Hello says what the connector can do; it follows AuthOK.
type Hello struct {
	Version      string       `json:"version"`
	OS           string       `json:"os"`
	Arch         string       `json:"arch"`
	Mode         string       `json:"mode"`
	Targets      []string     `json:"targets"`
	Features     Features     `json:"features"`
	NetworkScope NetworkScope `json:"networkScope"`
}

// Hop is a jump host. Its Auth defaults to the target's.
type Hop struct {
	Host string   `json:"host"`
	Port int      `json:"port"`
	User string   `json:"user"`
	Auth *AuthRef `json:"auth,omitempty"`
}

// HostKey is a host key the server remembers as trusted.
type HostKey struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	SHA256 string `json:"sha256"`
}

// Confirmation is a presented key the person confirmed; Replacing names the key it replaces.
type Confirmation struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	SHA256    string `json:"sha256"`
	Replacing string `json:"replacing,omitempty"`
}

// Lease is the idle and grace policy of an owned session (design §9).
type Lease struct {
	IdleTimeoutMin int `json:"idleTimeoutMin"`
	GracePeriodMin int `json:"gracePeriodMin"`
}

// TestConnection asks for the stages of design §5.1.
type TestConnection struct {
	RequestID     string         `json:"requestId"`
	Target        Target         `json:"target"`
	Runtime       Runtime        `json:"runtime"`
	Confirmations []Confirmation `json:"confirmations,omitempty" zero:"ok"`
}

// HopKey is one hop whose host key passed, in StageData.Hops.
type HopKey struct {
	Hop         string `json:"hop"`
	Fingerprint string `json:"fingerprint"`
	Address     string `json:"address,omitempty" zero:"ok"`
}

// StageData is the closed set of non-secret facts a stage may report.
type StageData struct {
	Hop            string   `json:"hop,omitempty"`
	Address        string   `json:"address,omitempty" zero:"ok"`
	Fingerprint    string   `json:"fingerprint,omitempty"`
	Expected       string   `json:"expected,omitempty"`
	Presented      string   `json:"presented,omitempty"`
	Algorithm      string   `json:"algorithm,omitempty" zero:"ok"`
	ResolvedPath   string   `json:"resolvedPath,omitempty"`
	RootDir        string   `json:"rootDir,omitempty"`
	Version        string   `json:"version,omitempty" zero:"ok"`
	Reason         string   `json:"reason,omitempty"`
	BlockedBy      string   `json:"blockedBy,omitempty"`
	State          string   `json:"state,omitempty"`
	Source         string   `json:"source,omitempty"`
	TerminalPrompt *bool    `json:"terminalPrompt,omitempty"`
	Hops           []HopKey `json:"hops,omitempty"`
}

// Stage is one stage report.
type Stage struct {
	Name   string     `json:"name"`
	Status string     `json:"status"`
	Code   Code       `json:"code,omitempty"`
	Detail string     `json:"detail,omitempty" zero:"ok"`
	Data   *StageData `json:"data,omitempty"`
	MS     *int64     `json:"ms,omitempty"`
}

// TestProgress reports one finished stage, or an ssh_auth stage waiting on the terminal.
type TestProgress struct {
	RequestID string `json:"requestId"`
	Stage     Stage  `json:"stage"`
}

// Kernelspec is one kernel a runtime offers.
type Kernelspec struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Language    string `json:"language"`
}

// Attachable is a running Jupyter server the connector found. Its token stays in the connector.
type Attachable struct {
	Port    int    `json:"port"`
	PID     int64  `json:"pid,omitempty"`
	RootDir string `json:"rootDir"`
}

// Environment is the version metadata recorded with a submission.
type Environment struct {
	OS      string `json:"os,omitempty" zero:"ok"`
	Arch    string `json:"arch,omitempty" zero:"ok"`
	Runtime string `json:"runtime,omitempty" zero:"ok"`
}

// TestResult is the final answer to TestConnection.
type TestResult struct {
	RequestID      string       `json:"requestId"`
	Outcome        string       `json:"outcome"`
	Stages         []Stage      `json:"stages"`
	Kernelspecs    []Kernelspec `json:"kernelspecs,omitempty" zero:"ok"`
	Attachable     []Attachable `json:"attachable,omitempty" zero:"ok"`
	JupyterVersion string       `json:"jupyterVersion,omitempty"`
	Environment    *Environment `json:"environment,omitempty"`
}

// OpenSession starts or attaches a runtime.
type OpenSession struct {
	RequestID string  `json:"requestId"`
	SessionID string  `json:"sessionId"`
	Target    Target  `json:"target"`
	Runtime   Runtime `json:"runtime"`
	Lease     Lease   `json:"lease"`
}

// SessionState reports a session's state.
type SessionState struct {
	SessionID      string       `json:"sessionId"`
	RequestID      string       `json:"requestId,omitempty"`
	State          string       `json:"state"`
	Owned          bool         `json:"owned"`
	Phase          string       `json:"phase,omitempty"`
	Cause          string       `json:"cause,omitempty"`
	Code           Code         `json:"code,omitempty"`
	Detail         string       `json:"detail,omitempty" zero:"ok"`
	JupyterVersion string       `json:"jupyterVersion,omitempty" zero:"ok"`
	Kernelspecs    []Kernelspec `json:"kernelspecs,omitempty" zero:"ok"`
	Environment    *Environment `json:"environment,omitempty"`
	LeaseExpiresAt string       `json:"leaseExpiresAt,omitempty"`
	TS             int64        `json:"ts"`
}

// CloseSession detaches (Stop false) or stops an owned session (Stop true).
type CloseSession struct {
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
	Stop      bool   `json:"stop"`
}

// Presence says whether any browser is attached to a session.
type Presence struct {
	SessionID string `json:"sessionId"`
	Attached  bool   `json:"attached"`
}

// Activity says a person did something in a session.
type Activity struct {
	SessionID string `json:"sessionId"`
}

// HTTP is one Jupyter REST call on a new stream.
type HTTP struct {
	StreamID      uint32  `json:"streamId"`
	SessionID     string  `json:"sessionId"`
	Purpose       string  `json:"purpose"`
	Method        string  `json:"method"`
	Path          string  `json:"path"`
	Headers       Headers `json:"headers"`
	Body          string  `json:"body"`
	ContentLength *int64  `json:"contentLength,omitempty"`
}

// HTTPHead is the head of a response; a body follows as frames when Body is "stream".
type HTTPHead struct {
	StreamID uint32  `json:"streamId"`
	Status   int     `json:"status"`
	Headers  Headers `json:"headers"`
	Body     string  `json:"body"`
}

// WSOpen opens a Jupyter WebSocket on a new stream.
type WSOpen struct {
	StreamID  uint32   `json:"streamId"`
	SessionID string   `json:"sessionId"`
	Path      string   `json:"path"`
	Protocols []string `json:"protocols,omitempty" zero:"ok"`
}

// WSOpened says the WebSocket is open.
type WSOpened struct {
	StreamID uint32 `json:"streamId"`
	Protocol string `json:"protocol,omitempty" zero:"ok"`
}

// WSClose closes a WebSocket stream.
type WSClose struct {
	StreamID uint32 `json:"streamId"`
	Code     int    `json:"code"`
	Reason   string `json:"reason,omitempty" zero:"ok"`
}

// Window grants the sender of a stream's data frames more bytes.
type Window struct {
	StreamID uint32 `json:"streamId"`
	Credit   int64  `json:"credit"`
}

// StreamReset aborts a stream.
type StreamReset struct {
	StreamID uint32 `json:"streamId"`
	Code     Code   `json:"code"`
	Detail   string `json:"detail,omitempty" zero:"ok"`
}

// Kernel is one kernel's state in a heartbeat.
type Kernel struct {
	ID             string `json:"id"`
	ExecutionState string `json:"executionState"`
	LastActivity   string `json:"lastActivity,omitempty"`
}

// HeartbeatSession is one held session in a heartbeat.
type HeartbeatSession struct {
	SessionID      string   `json:"sessionId"`
	State          string   `json:"state"`
	Phase          string   `json:"phase,omitempty"`
	Cause          string   `json:"cause,omitempty"`
	LeaseExpiresAt string   `json:"leaseExpiresAt,omitempty"`
	Kernels        []Kernel `json:"kernels,omitempty" zero:"ok"`
}

// Heartbeat is the connector's liveness and lease evidence.
type Heartbeat struct {
	Seq      int64              `json:"seq"`
	TS       int64              `json:"ts"`
	Sessions []HeartbeatSession `json:"sessions"`
}

// HeartbeatAck acknowledges a heartbeat.
type HeartbeatAck struct {
	Seq int64 `json:"seq"`
}

// Error is a refused or failed request.
type Error struct {
	RequestID string `json:"requestId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	StreamID  uint32 `json:"streamId,omitempty"`
	Code      Code   `json:"code"`
	Detail    string `json:"detail,omitempty" zero:"ok"`
}

func (*Challenge) Type() string      { return TChallenge }
func (*Auth) Type() string           { return TAuth }
func (*AuthOK) Type() string         { return TAuthOK }
func (*Hello) Type() string          { return THello }
func (*TestConnection) Type() string { return TTestConnection }
func (*TestProgress) Type() string   { return TTestProgress }
func (*TestResult) Type() string     { return TTestResult }
func (*OpenSession) Type() string    { return TOpenSession }
func (*SessionState) Type() string   { return TSessionState }
func (*CloseSession) Type() string   { return TCloseSession }
func (*Presence) Type() string       { return TPresence }
func (*Activity) Type() string       { return TActivity }
func (*HTTP) Type() string           { return THTTP }
func (*HTTPHead) Type() string       { return THTTPHead }
func (*WSOpen) Type() string         { return TWSOpen }
func (*WSOpened) Type() string       { return TWSOpened }
func (*WSClose) Type() string        { return TWSClose }
func (*Window) Type() string         { return TWindow }
func (*StreamReset) Type() string    { return TStreamReset }
func (*Heartbeat) Type() string      { return THeartbeat }
func (*HeartbeatAck) Type() string   { return THeartbeatAck }
func (*Error) Type() string          { return TError }
