package jupyter

import (
	"bytes"
	"context"
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

	"parallax/connector/internal/protocol"
)

// DialFunc connects to the session's Jupyter server: 127.0.0.1:<P> for a local target, the
// session's tunnel for an SSH one. It ignores whatever address a request names.
type DialFunc func(ctx context.Context) (net.Conn, error)

// LoopbackDial dials 127.0.0.1:port and nothing else.
func LoopbackDial(port int) DialFunc {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	return func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}
}

// Client talks to one Jupyter server with its token. It follows no redirects, uses no proxy,
// keeps no cookies and can dial only the session's server.
type Client struct {
	Port  int
	token string
	host  string
	hc    *http.Client
}

// NewClient returns a client for the server on port, reached through dial.
func NewClient(port int, token string, dial DialFunc) *Client {
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dial(ctx)
		},
		DisableCompression: true,
		MaxIdleConns:       4,
		ForceAttemptHTTP2:  false,
	}
	return &Client{
		Port:  port,
		token: token,
		host:  net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		hc: &http.Client{
			Transport: tr,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// CloseIdle closes idle connections, when the session ends.
func (c *Client) CloseIdle() { c.hc.CloseIdleConnections() }

// Origin is the origin the server itself has, sent on the kernel WebSocket.
func (c *Client) Origin() string { return "http://" + c.host }

// requestHeaders are the only headers the relay may set (design §7).
var requestHeaders = map[string]bool{"content-type": true, "accept": true}

// responseHeaders are the only headers returned to the relay; Set-Cookie, Location, Server and
// X-* are among those dropped.
var responseHeaders = []string{"content-type", "content-length", "etag", "last-modified", "cache-control"}

var reHeaderValue = regexp.MustCompile(`^[^\x00-\x1f\x7f]*$`)

func headerValueOK(v string) bool { return len(v) <= 1024 && reHeaderValue.MatchString(v) }

// FilterRequestHeaders keeps content-type and accept from the relay's headers.
func FilterRequestHeaders(h protocol.Headers) http.Header {
	out := http.Header{}
	for k, v := range h {
		if k = strings.ToLower(k); requestHeaders[k] && headerValueOK(v) {
			out.Set(k, v)
		}
	}
	return out
}

// FilterResponseHeaders keeps the headers of design §7 from a Jupyter response.
func FilterResponseHeaders(h http.Header) protocol.Headers {
	out := protocol.Headers{}
	for _, k := range responseHeaders {
		if v := h.Get(k); v != "" && headerValueOK(v) {
			out[k] = v
		}
	}
	return out
}

// target builds the URL from a decoded path and an encoded query, kept apart: a `?` or `#` in
// the path is escaped by url.URL, never read as the start of a query.
func (c *Client) target(scheme, path, rawQuery string) string {
	u := url.URL{Scheme: scheme, Host: c.host, Path: path, RawQuery: rawQuery}
	return u.String()
}

// Do sends one request. The relay's headers are filtered first; the token goes only in the
// Authorization header, never in the URL.
func (c *Client) Do(ctx context.Context, method, path, rawQuery string, relayHeaders protocol.Headers, body io.Reader, length int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.target("http", path, rawQuery), body)
	if err != nil {
		return nil, err
	}
	req.Header = FilterRequestHeaders(relayHeaders)
	req.Header.Set("Authorization", "token "+c.token)
	req.Host = c.host
	if body != nil {
		req.ContentLength = length
	}
	return c.hc.Do(req)
}

// Failure is a check or call that failed, with the catalogue code of its stage.
type Failure struct {
	Code   protocol.Code
	Detail string
}

func (e *Failure) Error() string { return e.Detail }

// call makes one of the connector's own calls and decodes a JSON answer.
func (c *Client) call(ctx context.Context, method, path string, out any) error {
	resp, err := c.Do(ctx, method, path, "", nil, nil, 0)
	if err != nil {
		return &Failure{Code: protocol.CodeNotebookServiceUnreachable, Detail: fmt.Sprintf("Jupyter did not answer %s", path)}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxSessionBody))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return &Failure{Code: protocol.CodeTokenRejected, Detail: fmt.Sprintf("Jupyter answered %s with %d", path, resp.StatusCode)}
	case resp.StatusCode/100 != 2:
		return &Failure{Code: protocol.CodeNotebookServiceUnreachable, Detail: fmt.Sprintf("Jupyter answered %s with %d", path, resp.StatusCode)}
	case err != nil:
		return &Failure{Code: protocol.CodeNotebookServiceUnreachable, Detail: fmt.Sprintf("reading %s: %v", path, err)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &Failure{Code: protocol.CodeNotebookServiceUnreachable, Detail: fmt.Sprintf("%s did not answer JSON", path)}
	}
	return nil
}

// Status checks GET /api/status with the token (the notebook_auth stage).
func (c *Client) Status(ctx context.Context) error {
	var v map[string]any
	return c.call(ctx, "GET", "/api/status", &v)
}

// Version returns the server's version from GET /api.
func (c *Client) Version(ctx context.Context) (string, error) {
	var v struct {
		Version string `json:"version"`
	}
	if err := c.call(ctx, "GET", "/api", &v); err != nil {
		return "", err
	}
	return v.Version, nil
}

// Kernelspecs lists the server's kernels (GET /api/kernelspecs).
func (c *Client) Kernelspecs(ctx context.Context) ([]protocol.Kernelspec, error) {
	var v serviceKernelspecs
	if err := c.call(ctx, "GET", "/api/kernelspecs", &v); err != nil {
		return nil, err
	}
	return v.list(), nil
}

// Shutdown asks the server to stop (POST /api/shutdown), used only by the connector itself.
func (c *Client) Shutdown(ctx context.Context) error {
	return c.call(ctx, "POST", "/api/shutdown", nil)
}

// KernelID reads the id from a POST /api/kernels answer.
func KernelID(body []byte) (string, error) {
	var v struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &v); err != nil || !reKernelUUID.MatchString(v.ID) {
		return "", errors.New("the kernel start answer has no kernel id")
	}
	return v.ID, nil
}

// FilterKernelList keeps only the session's kernels in a GET /api/kernels answer, so an
// attached server's other kernels are not even listed.
func FilterKernelList(body []byte, k *Kernels) ([]byte, error) {
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, errors.New("the kernel list is not a JSON array")
	}
	kept := []map[string]json.RawMessage{}
	for _, item := range list {
		var id string
		if json.Unmarshal(item["id"], &id) == nil && k.Has(id) {
			kept = append(kept, item)
		}
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(kept); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buf.Bytes()), nil
}
