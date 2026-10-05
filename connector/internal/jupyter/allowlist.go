// Package jupyter is the connector's side of the Jupyter Server it runs or attaches to
// (docs/design/connector.md §6, §7): the allowlist every relayed request must pass, an HTTP
// client that can reach only the session's server, the kernel-channel bridge, starting a local
// server, and reading `jupyter server list` and `jupyter kernelspec list`.
package jupyter

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"parallax/connector/internal/protocol"
)

// Purposes of an `http` request (design §4.3).
const (
	PurposeSession  = "session"
	PurposeContents = "contents"
)

// Body limits of design §4.5, for requests and responses alike.
const (
	MaxSessionBody  = 1 << 20
	MaxContentsBody = 64 << 20
	// MaxKernelStartBody is the limit of the one JSON body of POST /api/kernels.
	MaxKernelStartBody = 1 << 10
	maxPathLen         = 1024
)

// MaxBody returns the body limit for a purpose.
func MaxBody(purpose string) int64 {
	if purpose == PurposeContents {
		return MaxContentsBody
	}
	return MaxSessionBody
}

// Refusal is a request the connector will not pass on, with its catalogue code.
type Refusal struct {
	Code   protocol.Code
	Detail string
}

func (r *Refusal) Error() string { return fmt.Sprintf("%s: %s", r.Code, r.Detail) }

func notAllowed(format string, args ...any) *Refusal {
	return &Refusal{Code: protocol.CodePathNotAllowed, Detail: fmt.Sprintf(format, args...)}
}

// Kernels is the set of kernel ids one session created (design §7, confinement). Only these ids
// are accepted in a path, so on an attached server other people's kernels are out of reach.
type Kernels struct {
	mu  sync.Mutex
	ids map[string]bool
}

// Add records a kernel the session created.
func (k *Kernels) Add(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.ids == nil {
		k.ids = map[string]bool{}
	}
	k.ids[id] = true
}

// Remove forgets a deleted kernel.
func (k *Kernels) Remove(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.ids, id)
}

// Has reports whether the session created the kernel.
func (k *Kernels) Has(id string) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.ids[id]
}

// IDs returns the session's kernel ids.
func (k *Kernels) IDs() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := make([]string, 0, len(k.ids))
	for id := range k.ids {
		out = append(out, id)
	}
	return out
}

// Op is what an allowed request does, so the session can track kernels and check bodies.
type Op int

// Operations of the allowlist.
const (
	OpStatus Op = iota
	OpKernelspecs
	OpListKernels
	OpKernelState
	OpStartKernel
	OpDeleteKernel
	OpInterruptKernel
	OpRestartKernel
	OpChannels
	OpContentsGet
	OpContentsPut
	OpContentsPost
	OpContentsDelete
)

// Request is an allowed request: its operation and the exact path and query to send.
type Request struct {
	Op Op
	// URI is the decoded path plus a re-encoded query, to send to Jupyter.
	URI string
	// KernelID is the kernel the path names, if any.
	KernelID string
}

// Scope is what the allowlist checks a request against.
type Scope struct {
	// Kernels are the ids the session created.
	Kernels *Kernels
	// ContentRoot is the workspace relative to the server's root_dir, `/`-separated, empty
	// when the workspace is the root (an owned session).
	ContentRoot string
}

var (
	reKernelUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reQueryValue = regexp.MustCompile(`^[A-Za-z0-9._-]{0,64}$`)
	reKernelName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	contentsKeys = map[string]bool{"content": true, "type": true, "format": true, "hash": true}
)

// CheckHTTP applies the table of design §7 to one `http` request. A request outside it is a
// *Refusal with code path_not_allowed.
func CheckHTTP(purpose, method, rawPath string, s Scope) (Request, error) {
	path, query, err := splitPath(rawPath)
	if err != nil {
		return Request{}, err
	}
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	switch purpose {
	case PurposeSession:
		if len(query) > 0 {
			return Request{}, notAllowed("%s takes no query", path)
		}
		return checkSession(method, path, segs, s)
	case PurposeContents:
		return checkContents(method, path, segs, query, s)
	}
	return Request{}, notAllowed("unknown purpose %q", purpose)
}

func checkSession(method, path string, segs []string, s Scope) (Request, error) {
	// segs[0] is "api".
	switch {
	case len(segs) == 2 && segs[1] == "status" && method == "GET":
		return Request{Op: OpStatus, URI: path}, nil
	case len(segs) == 2 && segs[1] == "kernelspecs" && method == "GET":
		return Request{Op: OpKernelspecs, URI: path}, nil
	case len(segs) == 2 && segs[1] == "kernels":
		switch method {
		case "GET":
			return Request{Op: OpListKernels, URI: path}, nil
		case "POST":
			return Request{Op: OpStartKernel, URI: path}, nil
		}
	case len(segs) == 3 && segs[1] == "kernels":
		id, err := ownKernel(segs[2], s)
		if err != nil {
			return Request{}, err
		}
		switch method {
		case "GET":
			return Request{Op: OpKernelState, URI: path, KernelID: id}, nil
		case "DELETE":
			return Request{Op: OpDeleteKernel, URI: path, KernelID: id}, nil
		}
	case len(segs) == 4 && segs[1] == "kernels" && method == "POST" && (segs[3] == "interrupt" || segs[3] == "restart"):
		id, err := ownKernel(segs[2], s)
		if err != nil {
			return Request{}, err
		}
		op := OpInterruptKernel
		if segs[3] == "restart" {
			op = OpRestartKernel
		}
		return Request{Op: op, URI: path, KernelID: id}, nil
	}
	return Request{}, notAllowed("%s %s is not served", method, path)
}

func ownKernel(id string, s Scope) (string, error) {
	if !reKernelUUID.MatchString(id) {
		return "", notAllowed("%q is not a kernel id", id)
	}
	if s.Kernels == nil || !s.Kernels.Has(id) {
		return "", notAllowed("kernel %s was not started by this session", id)
	}
	return id, nil
}

func checkContents(method, path string, segs []string, query url.Values, s Scope) (Request, error) {
	if len(segs) < 2 || segs[1] != "contents" {
		return Request{}, notAllowed("%s is not a contents path", path)
	}
	rel := segs[2:]
	if len(rel) > 0 && rel[len(rel)-1] == "" {
		rel = rel[:len(rel)-1] // a trailing slash names the same directory
	}
	var op Op
	switch method {
	case "GET":
		op = OpContentsGet
	case "PUT":
		op = OpContentsPut
	case "POST":
		op = OpContentsPost
	case "DELETE":
		op = OpContentsDelete
	default:
		return Request{}, notAllowed("%s is not allowed on contents", method)
	}
	if len(query) > 0 && op != OpContentsGet && op != OpContentsPut {
		return Request{}, notAllowed("%s on contents takes no query", method)
	}
	for k := range query {
		if !contentsKeys[k] {
			return Request{}, notAllowed("query key %q is not allowed", k)
		}
	}
	// The path must be the content root or lie below it, segment by segment. Writing or deleting
	// the root itself is not a file operation.
	var root []string
	if s.ContentRoot != "" {
		root = strings.Split(s.ContentRoot, "/")
	}
	if len(rel) < len(root) {
		return Request{}, notAllowed("%s is outside the session's workspace", path)
	}
	for i, r := range root {
		if rel[i] != r {
			return Request{}, notAllowed("%s is outside the session's workspace", path)
		}
	}
	if len(rel) == len(root) && (op == OpContentsPut || op == OpContentsDelete) {
		return Request{}, notAllowed("%s names the workspace itself", path)
	}
	uri := path
	if len(query) > 0 {
		uri += "?" + query.Encode()
	}
	return Request{Op: op, URI: uri}, nil
}

// CheckWS applies the table of design §7 to a `ws_open`: only a kernel channel of a kernel the
// session created, with session_id a UUID and no subprotocol.
func CheckWS(rawPath string, protocols []string, s Scope) (Request, error) {
	if len(protocols) > 0 {
		return Request{}, notAllowed("kernel channels are opened without a subprotocol")
	}
	path, query, err := splitPath(rawPath)
	if err != nil {
		return Request{}, err
	}
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(segs) != 4 || segs[1] != "kernels" || segs[3] != "channels" {
		return Request{}, notAllowed("%s is not a kernel channel", path)
	}
	id, err := ownKernel(segs[2], s)
	if err != nil {
		return Request{}, err
	}
	if len(query) != 1 || len(query["session_id"]) != 1 || !reKernelUUID.MatchString(query.Get("session_id")) {
		return Request{}, notAllowed("a kernel channel takes exactly session_id=<uuid>")
	}
	return Request{Op: OpChannels, URI: path + "?" + query.Encode(), KernelID: id}, nil
}

// splitPath applies the path rules of design §7 and returns the decoded path and the query.
func splitPath(raw string) (string, url.Values, error) {
	if len(raw) > maxPathLen*2 {
		return "", nil, notAllowed("the path is too long")
	}
	rawPath, rawQuery, _ := strings.Cut(raw, "?")
	if strings.Contains(raw, "#") {
		return "", nil, notAllowed("a fragment is not allowed")
	}
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", nil, notAllowed("the path has a bad escape")
	}
	if again, err := url.PathUnescape(path); err != nil || again != path {
		return "", nil, notAllowed("the path is encoded twice")
	}
	switch {
	case len(path) > maxPathLen:
		return "", nil, notAllowed("the path is longer than %d bytes", maxPathLen)
	case strings.ContainsAny(path, "\x00\\"):
		return "", nil, notAllowed("the path has a NUL or a backslash")
	case strings.ContainsFunc(path, func(r rune) bool { return r < 0x20 || r == 0x7f }):
		return "", nil, notAllowed("the path has a control character")
	case !strings.HasPrefix(path, "/api/"):
		return "", nil, notAllowed("the path is not under /api/")
	case strings.Contains(path, "//"):
		return "", nil, notAllowed("the path has an empty segment")
	}
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, seg := range segs {
		if seg == "" && i == len(segs)-1 {
			continue // a trailing slash
		}
		if strings.HasPrefix(seg, ".") {
			return "", nil, notAllowed("the path has a . or .. segment, or a hidden one")
		}
	}
	query, err := parseQuery(rawQuery)
	if err != nil {
		return "", nil, err
	}
	return path, query, nil
}

func parseQuery(raw string) (url.Values, error) {
	q := url.Values{}
	if raw == "" {
		return q, nil
	}
	for _, part := range strings.Split(raw, "&") {
		k, v, _ := strings.Cut(part, "=")
		key, err1 := url.QueryUnescape(k)
		val, err2 := url.QueryUnescape(v)
		if err1 != nil || err2 != nil {
			return nil, notAllowed("the query has a bad escape")
		}
		lower := strings.ToLower(key)
		if lower == "token" || lower == "_xsrf" {
			return nil, notAllowed("%s is never accepted in a query", lower)
		}
		if q.Has(key) {
			return nil, notAllowed("query key %q is repeated", key)
		}
		if !reQueryValue.MatchString(val) {
			return nil, notAllowed("query value for %q is not a simple value", key)
		}
		q.Set(key, val)
	}
	return q, nil
}

// CheckKernelStart checks the body of POST /api/kernels: a JSON object holding only a kernel
// name, at most 1 KiB. It returns the name.
func CheckKernelStart(body []byte) (string, error) {
	if len(body) > MaxKernelStartBody {
		return "", &Refusal{Code: protocol.CodeBodyTooLarge, Detail: "a kernel start body is at most 1 KiB"}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return "", notAllowed("a kernel start body is a JSON object")
	}
	var name string
	if len(m) != 1 || json.Unmarshal(m["name"], &name) != nil || !reKernelName.MatchString(name) {
		return "", notAllowed("a kernel start body holds only a kernel name")
	}
	return name, nil
}

// CheckContentsPost checks the body of POST /api/contents/{reldir}: a JSON object with at most
// `type` and `ext`; `copy_from` and every other key are refused.
func CheckContentsPost(body []byte) error {
	if len(body) > MaxKernelStartBody {
		return &Refusal{Code: protocol.CodeBodyTooLarge, Detail: "a new-file body is at most 1 KiB"}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return notAllowed("a new-file body is a JSON object")
	}
	for k, v := range m {
		var s string
		if (k != "type" && k != "ext") || json.Unmarshal(v, &s) != nil || !reQueryValue.MatchString(s) {
			return notAllowed("a new-file body may hold only type and ext")
		}
	}
	return nil
}
