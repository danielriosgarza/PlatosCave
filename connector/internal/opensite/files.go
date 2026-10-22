package opensite

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Limits of a notebook's files (the zip a level 0 build offers beside it, docs/design/open-site.md §4).
const (
	// MaxFilesZip bounds the zip as downloaded.
	MaxFilesZip = 256 << 20
	// maxFilesTotal bounds what it unpacks to.
	maxFilesTotal = 512 << 20
	maxFilesCount = 2000
	filesTimeout  = 2 * time.Minute
)

// FilesURL is the address of a notebook's files: an object of the site, named by the SHA-256 of
// its bytes.
type FilesURL struct {
	URL    *url.URL
	SHA256 string
}

// reObject is how a level 0 build names an object: content/o/<sha256>.<ext>.
var reObject = regexp.MustCompile(`/o/([0-9a-f]{64})\.zip$`)

// ParseFilesURL accepts the zip of a level 0 build: https (http only on this computer), with no
// user name, query or fragment, at a path that ends in o/<sha256>.zip.
func ParseFilesURL(raw string) (*FilesURL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("the files' address is not a site's file")
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(u.Host, "[") {
		host = "[" + host + "]"
	}
	if !(u.Scheme == "https" && host != "" || u.Scheme == "http" && loopbackHost(host)) {
		return nil, errors.New("the files' address is not https")
	}
	m := reObject.FindStringSubmatch(u.Path)
	if m == nil || u.RawPath != "" && u.RawPath != u.EscapedPath() {
		return nil, errors.New("the files' address does not name a site's zip")
	}
	return &FilesURL{URL: u, SHA256: m[1]}, nil
}

// NewFilesClient is the client of Download: no redirects, no cookies, the environment's proxy.
func NewFilesClient() *http.Client {
	return &http.Client{
		Timeout: filesTimeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			TLSHandshakeTimeout: 15 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// Download fetches the zip and checks its bytes against the hash it is named by.
func Download(ctx context.Context, c *http.Client, f *FilesURL) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the notebook's files could not be downloaded from %s", f.URL.Host)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d for the notebook's files", f.URL.Host, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxFilesZip+1))
	if err != nil {
		return nil, fmt.Errorf("the notebook's files could not be downloaded from %s", f.URL.Host)
	}
	if len(data) > MaxFilesZip {
		return nil, fmt.Errorf("the notebook's files are larger than %d MiB", MaxFilesZip>>20)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != f.SHA256 {
		return nil, errors.New("the notebook's files are not the ones the site names")
	}
	return data, nil
}

// entryPath is a zip entry's path below its one top folder (the notebook's name), or false for
// a name that could reach outside the folder or that a file system could read otherwise.
func entryPath(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || path.Clean(name) != name {
		return "", false
	}
	_, rest, ok := strings.Cut(name, "/")
	if !ok || rest == "" {
		return "", false
	}
	for _, seg := range strings.Split(rest, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.TrimRight(seg, ". ") != seg {
			return "", false
		}
	}
	return rest, true
}

// Extract writes the zip's files into dir, below their one top folder, and returns the paths
// written and the paths kept: a file already there with other contents is the person's and is
// never replaced. Only regular files are written, never through a link; a zip with any other
// entry, or with a name that could leave dir, writes nothing.
func Extract(data []byte, dir string) (written, kept []string, err error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, errors.New("the notebook's files are not a zip")
	}
	if len(zr.File) > maxFilesCount {
		return nil, nil, fmt.Errorf("the notebook has more than %d files", maxFilesCount)
	}
	type entry struct {
		f   *zip.File
		rel string
	}
	var entries []entry
	top := ""
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") && f.Mode().IsDir() {
			continue
		}
		rel, ok := entryPath(f.Name)
		if !ok || !f.Mode().IsRegular() {
			return nil, nil, fmt.Errorf("the notebook's files hold an entry that is not a plain file: %q", clip(f.Name))
		}
		first, _, _ := strings.Cut(f.Name, "/")
		if top == "" {
			top = first
		} else if first != top {
			return nil, nil, errors.New("the notebook's files are not in one folder")
		}
		entries = append(entries, entry{f, rel})
	}
	var total int64
	written, kept = []string{}, []string{}
	for _, e := range entries {
		target := filepath.Join(dir, filepath.FromSlash(e.rel))
		if !within(dir, target) {
			return written, kept, fmt.Errorf("%q is outside the notebook's folder", clip(e.rel))
		}
		rc, err := e.f.Open()
		if err != nil {
			return written, kept, fmt.Errorf("%q cannot be read from the zip", clip(e.rel))
		}
		content, err := io.ReadAll(io.LimitReader(rc, maxFilesTotal-total+1))
		rc.Close()
		if err != nil {
			return written, kept, fmt.Errorf("%q cannot be read from the zip", clip(e.rel))
		}
		total += int64(len(content))
		if total > maxFilesTotal {
			return written, kept, fmt.Errorf("the notebook's files unpack to more than %d MiB", maxFilesTotal>>20)
		}
		switch same, err := sameFile(target, content); {
		case err == nil && same:
			continue
		case err == nil:
			kept = append(kept, e.rel)
			continue
		case !errors.Is(err, fs.ErrNotExist):
			kept = append(kept, e.rel)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return written, kept, fmt.Errorf("the folder for %q cannot be created", clip(e.rel))
		}
		// O_EXCL: a file or link that appeared since is left alone, never written through.
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			kept = append(kept, e.rel)
			continue
		}
		_, werr := out.Write(content)
		cerr := out.Close()
		if werr != nil || cerr != nil {
			os.Remove(target)
			return written, kept, fmt.Errorf("%q could not be written", clip(e.rel))
		}
		written = append(written, e.rel)
	}
	return written, kept, nil
}

// sameFile reports whether target is a regular file with exactly content; fs.ErrNotExist when
// nothing is there, and an error for anything that is not a regular file.
func sameFile(target string, content []byte) (bool, error) {
	st, err := os.Lstat(target)
	if err != nil {
		return false, err
	}
	if !st.Mode().IsRegular() {
		return false, errors.New("not a regular file")
	}
	if st.Size() != int64(len(content)) {
		return false, nil
	}
	have, err := os.ReadFile(target)
	if err != nil {
		return false, err
	}
	return bytes.Equal(have, content), nil
}

func clip(s string) string {
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}
