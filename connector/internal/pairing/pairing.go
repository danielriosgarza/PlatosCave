// Package pairing is the connector's client for POST /api/connector/v1/pair, /pair/poll and
// /unpair (docs/design/connector.md §3), plus the normalisation of the server origin and the
// pairing code that both sides must agree on.
package pairing

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/version"
)

// Endpoint paths under the server origin.
const (
	PairPath   = "/api/connector/v1/pair"
	PollPath   = "/api/connector/v1/pair/poll"
	UnpairPath = "/api/connector/v1/unpair"
)

// RequestTimeout bounds one pairing request, connection set-up included.
const RequestTimeout = 30 * time.Second

const maxResponseBody = 64 << 10

var (
	// ErrNotFound is a 404: a wrong, used or expired code, or a connector the server does not know.
	ErrNotFound = errors.New("not found")
	// ErrRejected means the owner rejected the device in the web app.
	ErrRejected = errors.New("the device was rejected in Parallax")
	// ErrExpired means the device was not approved in time.
	ErrExpired = errors.New("the device was not approved in time")
)

// APIError is a refusal with an ErrorBody.
type APIError struct {
	Status     int
	Message    string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("server answered %d", e.Status)
	}
	return fmt.Sprintf("server answered %d: %s", e.Status, e.Message)
}

// Is lets errors.Is(err, ErrNotFound) match a 404.
func (e *APIError) Is(target error) bool {
	return target == ErrNotFound && e.Status == http.StatusNotFound
}

// Transient reports whether an error is worth retrying: a network failure, a 5xx or a 429.
func Transient(err error) bool {
	var api *APIError
	if errors.As(err, &api) {
		return api.Status == http.StatusTooManyRequests || api.Status >= 500
	}
	var certErr *tls.CertificateVerificationError
	var headerErr tls.RecordHeaderError
	if errors.As(err, &certErr) || errors.As(err, &headerErr) {
		return false
	}
	var netErr net.Error
	return errors.As(err, &netErr) || errors.Is(err, io.ErrUnexpectedEOF)
}

// IsLoopbackHost reports whether a host (without port or brackets) is one of the three names
// for which http:// is accepted (design §4.1).
func IsLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

var originPattern = regexp.MustCompile(`^https?://[a-z0-9.:\[\]-]+$`)

// NormaliseServer turns --server into the origin that is stored in config.json and signed:
// scheme://host[:port], lower case, no trailing slash, default port omitted. It refuses a path,
// query, fragment or credentials, and plain http:// for anything but a loopback host.
func NormaliseServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("--server: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", fmt.Errorf("--server must start with https://, got %q", raw)
	}
	if u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", errors.New("--server must be only the address of Parallax, such as https://parallax.example.org")
	}
	if u.Path != "" && u.Path != "/" {
		return "", errors.New("--server must be only the address of Parallax, without a path")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("--server has no host")
	}
	for _, r := range host {
		if r > unicode.MaxASCII {
			return "", errors.New("--server: write an international domain name in its xn-- form")
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("--server: port %q is not valid", port)
		}
		port = strconv.Itoa(n)
		if (scheme == "https" && n == 443) || (scheme == "http" && n == 80) {
			port = ""
		}
	}
	if scheme == "http" && !IsLoopbackHost(host) {
		return "", errors.New("--server must use https:// (http:// is accepted only for 127.0.0.1, [::1] and localhost)")
	}
	hostPart := host
	if strings.Contains(host, ":") {
		hostPart = "[" + host + "]"
	}
	origin := scheme + "://" + hostPart
	if port != "" {
		origin += ":" + port
	}
	if len(origin) > 255 || !originPattern.MatchString(origin) {
		return "", fmt.Errorf("--server: %q is not a valid address", raw)
	}
	return origin, nil
}

var codePattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{8}$`)

// NormaliseCode turns a typed pairing code into the form sent in PairRequest: upper case,
// hyphens and spaces removed, O read as 0 and I and L as 1, eight Crockford base 32 characters.
func NormaliseCode(raw string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToUpper(raw) {
		switch {
		case r == '-' || unicode.IsSpace(r):
			continue
		case r == 'O':
			b.WriteByte('0')
		case r == 'I' || r == 'L':
			b.WriteByte('1')
		default:
			b.WriteRune(r)
		}
	}
	code := b.String()
	if !codePattern.MatchString(code) {
		return "", errors.New("--code must be the eight-character code shown in Parallax, such as K7M2-Q9XD")
	}
	return code, nil
}

// MaxNameLength is the longest device name the server accepts, in characters.
const MaxNameLength = 60

// CheckName applies PairRequest's rule for name: 1 to 60 characters, no control characters.
func CheckName(name string) error {
	n := utf8.RuneCountInString(name)
	if !utf8.ValidString(name) || n < 1 || n > MaxNameLength {
		return fmt.Errorf("--name must be 1 to %d characters", MaxNameLength)
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return errors.New("--name must not contain control characters")
		}
	}
	return nil
}

// DefaultName derives a device name from the host name: control characters dropped,
// shortened to 60 characters, "This computer" when nothing is left.
func DefaultName(hostname string) string {
	var b strings.Builder
	n := 0
	for _, r := range hostname {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			continue
		}
		if n == MaxNameLength {
			break
		}
		b.WriteRune(r)
		n++
	}
	if name := strings.TrimSpace(b.String()); name != "" {
		return name
	}
	return "This computer"
}

// PairRequest is the body of POST /api/connector/v1/pair.
type PairRequest struct {
	Code      string `json:"code"`
	PublicKey string `json:"publicKey"`
	Name      string `json:"name"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Version   string `json:"version"`
}

// PairResponse is the 201 answer to a pair request.
type PairResponse struct {
	ConnectorID      string `json:"connectorId"`
	Fingerprint      string `json:"fingerprint"`
	Status           string `json:"status"`
	PollAfterSeconds int    `json:"pollAfterSeconds"`
	ApproveBy        string `json:"approveBy"`
}

// SignedRequest is the body of /pair/poll and /unpair.
type SignedRequest struct {
	ConnectorID string `json:"connectorId"`
	TS          int64  `json:"ts"`
	Sig         string `json:"sig"`
}

// PollResponse is the answer to a poll.
type PollResponse struct {
	Status           string `json:"status"`
	PollAfterSeconds int    `json:"pollAfterSeconds,omitempty"`
}

// ErrorBody is every refusal's body.
type ErrorBody struct {
	Error string `json:"error"`
}

var (
	uuidPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	fingerprintPattern = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
	semverPattern      = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
	b64url32Pattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	b64url64Pattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{86}$`)
	timestampPattern   = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
)

// Validate applies pairing.schema.json#/$defs/PairRequest.
func (r PairRequest) Validate() error {
	switch {
	case !codePattern.MatchString(r.Code):
		return errors.New("pairing code is not normalised")
	case !b64url32Pattern.MatchString(r.PublicKey):
		return errors.New("public key is not 32 bytes of base64url")
	case CheckName(r.Name) != nil:
		return CheckName(r.Name)
	case r.OS != "linux" && r.OS != "darwin" && r.OS != "windows":
		return fmt.Errorf("operating system %q is not supported", r.OS)
	case r.Arch != "amd64" && r.Arch != "arm64":
		return fmt.Errorf("architecture %q is not supported", r.Arch)
	case len(r.Version) > 32 || !semverPattern.MatchString(r.Version):
		return fmt.Errorf("version %q is not a semantic version", r.Version)
	}
	return nil
}

// Validate applies pairing.schema.json#/$defs/PairResponse.
func (r PairResponse) Validate() error {
	switch {
	case !uuidPattern.MatchString(r.ConnectorID):
		return errors.New("connectorId is not a lower-case UUID")
	case !fingerprintPattern.MatchString(r.Fingerprint):
		return errors.New("fingerprint is malformed")
	case r.Status != "pending":
		return fmt.Errorf("status %q, want pending", r.Status)
	case r.PollAfterSeconds < 1 || r.PollAfterSeconds > 60:
		return fmt.Errorf("pollAfterSeconds %d out of range", r.PollAfterSeconds)
	case !timestampPattern.MatchString(r.ApproveBy):
		return errors.New("approveBy is not an RFC 3339 UTC time")
	}
	return nil
}

// Validate applies pairing.schema.json#/$defs/SignedRequest.
func (r SignedRequest) Validate() error {
	switch {
	case !uuidPattern.MatchString(r.ConnectorID):
		return errors.New("connectorId is not a lower-case UUID")
	case r.TS < 0 || r.TS > 4102444800:
		return errors.New("ts out of range")
	case !b64url64Pattern.MatchString(r.Sig):
		return errors.New("sig is not 64 bytes of base64url")
	}
	return nil
}

// Validate applies pairing.schema.json#/$defs/PollResponse.
func (r PollResponse) Validate() error {
	switch r.Status {
	case "pending", "active", "rejected", "expired":
	default:
		return fmt.Errorf("status %q is not a poll status", r.Status)
	}
	if r.PollAfterSeconds != 0 && (r.PollAfterSeconds < 1 || r.PollAfterSeconds > 60) {
		return fmt.Errorf("pollAfterSeconds %d out of range", r.PollAfterSeconds)
	}
	return nil
}

// NewHTTPClient returns the client used for the pairing endpoints: request timeout, TLS 1.2 or
// later, HTTPS_PROXY honoured, and redirects never followed (a redirect would send a signed
// request somewhere the person did not pair with).
func NewHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	transport.Proxy = http.ProxyFromEnvironment
	return &http.Client{
		Transport: transport,
		Timeout:   RequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Client talks to one server origin.
type Client struct {
	Origin string
	HTTP   *http.Client
	Now    func() time.Time
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return NewHTTPClient()
}

// Pair sends a pair request and returns the validated response. The response's fingerprint
// must be the one of the key that was sent.
func (c *Client) Pair(ctx context.Context, req PairRequest, want string) (*PairResponse, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	var resp PairResponse
	if err := c.post(ctx, PairPath, req, &resp, http.StatusCreated, http.StatusOK); err != nil {
		return nil, err
	}
	if err := resp.Validate(); err != nil {
		return nil, fmt.Errorf("pair: unexpected answer from the server: %w", err)
	}
	if resp.Fingerprint != want {
		return nil, fmt.Errorf("pair: the server recorded fingerprint %s, but this computer's key is %s; do not approve the device", resp.Fingerprint, want)
	}
	return &resp, nil
}

func (c *Client) signed(id *identity.Identity, connectorID string, sign func(*identity.Identity, string, int64, string) (string, error)) (SignedRequest, error) {
	ts := c.now().Unix()
	sig, err := sign(id, connectorID, ts, c.Origin)
	if err != nil {
		return SignedRequest{}, err
	}
	return SignedRequest{ConnectorID: connectorID, TS: ts, Sig: sig}, nil
}

// Poll asks whether the device has been approved.
func (c *Client) Poll(ctx context.Context, id *identity.Identity, connectorID string) (*PollResponse, error) {
	req, err := c.signed(id, connectorID, (*identity.Identity).SignPoll)
	if err != nil {
		return nil, err
	}
	var resp PollResponse
	if err := c.post(ctx, PollPath, req, &resp, http.StatusOK); err != nil {
		return nil, err
	}
	if err := resp.Validate(); err != nil {
		return nil, fmt.Errorf("poll: unexpected answer from the server: %w", err)
	}
	return &resp, nil
}

// Unpair tells the server to revoke this connector.
func (c *Client) Unpair(ctx context.Context, id *identity.Identity, connectorID string) error {
	req, err := c.signed(id, connectorID, (*identity.Identity).SignUnpair)
	if err != nil {
		return err
	}
	return c.post(ctx, UnpairPath, req, nil, http.StatusOK, http.StatusNoContent)
}

// Sleeper waits for d or until ctx ends.
type Sleeper func(ctx context.Context, d time.Duration) error

// Sleep is the real Sleeper.
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// approvalGrace allows for clock differences around approveBy before giving up locally.
const approvalGrace = 30 * time.Second

const maxRetryWait = 30 * time.Second

// WaitForApproval polls until the device is active, rejected or expired, or the approval
// deadline has passed. Network failures, 5xx and 429 answers are retried with a growing wait.
func (c *Client) WaitForApproval(ctx context.Context, id *identity.Identity, pr *PairResponse, sleep Sleeper) error {
	if sleep == nil {
		sleep = Sleep
	}
	deadline, err := time.Parse(time.RFC3339, pr.ApproveBy)
	if err != nil {
		return fmt.Errorf("approveBy: %w", err)
	}
	deadline = deadline.Add(approvalGrace)
	interval := time.Duration(pr.PollAfterSeconds) * time.Second
	wait, backoff := interval, interval
	for {
		if err := sleep(ctx, wait); err != nil {
			return err
		}
		resp, err := c.Poll(ctx, id, pr.ConnectorID)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !Transient(err) || !c.now().Before(deadline) {
				return err
			}
			backoff = min(backoff*2, maxRetryWait)
			var api *APIError
			if errors.As(err, &api) && api.RetryAfter > backoff {
				backoff = api.RetryAfter
			}
			wait = backoff
			continue
		}
		switch resp.Status {
		case "active":
			return nil
		case "rejected":
			return ErrRejected
		case "expired":
			return ErrExpired
		}
		if resp.PollAfterSeconds > 0 {
			interval = time.Duration(resp.PollAfterSeconds) * time.Second
		}
		wait, backoff = interval, interval
		if !c.now().Before(deadline) {
			return ErrExpired
		}
	}
}

func (c *Client) post(ctx context.Context, path string, body, out any, okStatus ...int) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Origin+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "parallax-connector/"+version.String())
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err // a *url.Error already names the method and URL
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if len(data) > maxResponseBody {
		return fmt.Errorf("%s: answer larger than %d bytes", path, maxResponseBody)
	}
	for _, s := range okStatus {
		if resp.StatusCode == s {
			if out == nil {
				return nil
			}
			if err := decodeStrict(data, out); err != nil {
				return fmt.Errorf("%s: unexpected answer from the server: %w", path, err)
			}
			return nil
		}
	}
	apiErr := &APIError{Status: resp.StatusCode}
	var eb ErrorBody
	if decodeStrict(data, &eb) == nil {
		apiErr.Message = printable(eb.Error, 200)
	}
	if s := resp.Header.Get("Retry-After"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 3600 {
			apiErr.RetryAfter = time.Duration(n) * time.Second
		}
	}
	return apiErr
}

// printable drops control characters (a server message is printed on a terminal) and shortens.
func printable(s string, max int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || r == utf8.RuneError {
			continue
		}
		if n == max {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}
