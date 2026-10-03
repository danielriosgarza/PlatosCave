package pairing_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/testserver"
)

func TestNormaliseServer(t *testing.T) {
	ok := map[string]string{
		"https://parallax.example.org":       "https://parallax.example.org",
		"https://Parallax.Example.ORG/":      "https://parallax.example.org",
		"HTTPS://parallax.example.org:443":   "https://parallax.example.org",
		"https://parallax.example.org:8443/": "https://parallax.example.org:8443",
		"http://127.0.0.1:3000":              "http://127.0.0.1:3000",
		"http://localhost:80":                "http://localhost",
		"http://[::1]:5173":                  "http://[::1]:5173",
		"https://[2001:DB8::1]:443":          "https://[2001:db8::1]",
		"  https://parallax.example.org  ":   "https://parallax.example.org",
	}
	for in, want := range ok {
		got, err := pairing.NormaliseServer(in)
		if err != nil || got != want {
			t.Errorf("NormaliseServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"http://parallax.example.org",       // plain http off loopback
		"http://127.0.0.2:3000",             // only the three loopback names
		"ws://127.0.0.1:3000",               // not an http scheme
		"parallax.example.org",              // no scheme
		"https://parallax.example.org/app",  // path
		"https://parallax.example.org/?x=1", // query
		"https://parallax.example.org/#x",   // fragment
		"https://user:pw@parallax.example.org",
		"https://parallax.example.org:0",
		"https://parallax.example.org:70000",
		"https://bücher.example",
		"https://",
	} {
		if got, err := pairing.NormaliseServer(in); err == nil {
			t.Errorf("NormaliseServer(%q) = %q, want an error", in, got)
		}
	}
}

func TestNormaliseCode(t *testing.T) {
	ok := map[string]string{
		"K7M2-Q9XD":  "K7M2Q9XD",
		"k7m2q9xd":   "K7M2Q9XD",
		" k7m2 q9xd": "K7M2Q9XD",
		"OIL0-1234":  "0110" + "1234",
		"o0il-abcd":  "0011ABCD",
	}
	for in, want := range ok {
		got, err := pairing.NormaliseCode(in)
		if err != nil || got != want {
			t.Errorf("NormaliseCode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "K7M2-Q9X", "K7M2-Q9XDD", "K7M2-Q9XU", "K7M2_Q9XD", "K7M2-Q9X!"} {
		if got, err := pairing.NormaliseCode(in); err == nil {
			t.Errorf("NormaliseCode(%q) = %q, want an error", in, got)
		}
	}
}

func TestNames(t *testing.T) {
	if err := pairing.CheckName("Elena's laptop"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", strings.Repeat("é", 61), "tab\there", "bell\x07"} {
		if pairing.CheckName(bad) == nil {
			t.Errorf("CheckName(%q) accepted", bad)
		}
	}
	if got := pairing.DefaultName("lab-07\x1b[31m"); got != "lab-07[31m" {
		t.Errorf("DefaultName dropped the wrong characters: %q", got)
	}
	if got := pairing.DefaultName(strings.Repeat("h", 80)); len(got) != 60 {
		t.Errorf("DefaultName length %d", len(got))
	}
	if got := pairing.DefaultName("\x00"); got != "This computer" {
		t.Errorf("DefaultName fallback %q", got)
	}
	if pairing.CheckName(pairing.DefaultName(strings.Repeat("ü", 90))) != nil {
		t.Error("DefaultName produced a name CheckName refuses")
	}
}

func request(t *testing.T, id *identity.Identity, code string) pairing.PairRequest {
	t.Helper()
	normal, err := pairing.NormaliseCode(code)
	if err != nil {
		t.Fatal(err)
	}
	return pairing.PairRequest{Code: normal, PublicKey: id.PublicKeyBase64(), Name: "Test laptop", OS: "linux", Arch: "amd64", Version: "0.1.0"}
}

func noSleep(ctx context.Context, _ time.Duration) error { return ctx.Err() }

func TestPairPollAndUnpairAgainstTestServer(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("K7M2-Q9XD")
	srv.OnPoll = func(s *testserver.Server, id string, polls int) {
		if polls == 3 {
			s.Approve(id)
		}
	}
	id, _ := identity.Generate()
	c := &pairing.Client{Origin: srv.Origin, HTTP: srv.Client()}
	resp, err := c.Pair(context.Background(), request(t, id, "k7m2q9xd"), id.Fingerprint())
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WaitForApproval(context.Background(), id, resp, noSleep); err != nil {
		t.Fatal(err)
	}
	got, _ := srv.Connector(resp.ConnectorID)
	if got.Polls != 3 || got.Status != testserver.StatusActive || got.Fingerprint != id.Fingerprint() {
		t.Fatalf("server record %+v", got)
	}
	// A code is single use.
	other, _ := identity.Generate()
	if _, err := c.Pair(context.Background(), request(t, other, "K7M2-Q9XD"), other.Fingerprint()); !errors.Is(err, pairing.ErrNotFound) {
		t.Fatalf("reused code: %v", err)
	}
	// Another key cannot poll or unpair as this connector.
	if _, err := c.Poll(context.Background(), other, resp.ConnectorID); err == nil {
		t.Fatal("poll signed with another key accepted")
	}
	// A signature for another origin is refused.
	wrongOrigin := &pairing.Client{Origin: srv.Origin, HTTP: srv.Client()}
	srv.Origin = "https://parallax.example.org"
	if _, err := wrongOrigin.Poll(context.Background(), id, resp.ConnectorID); err == nil {
		t.Fatal("poll signed for another origin accepted")
	}
	srv.Origin = c.Origin
	if err := c.Unpair(context.Background(), id, resp.ConnectorID); err != nil {
		t.Fatal(err)
	}
	if got, _ := srv.Connector(resp.ConnectorID); got.Status != testserver.StatusRevoked || !got.Unpaired {
		t.Fatalf("after unpair %+v", got)
	}
}

func TestWaitForApprovalOutcomes(t *testing.T) {
	for _, c := range []struct {
		name  string
		act   func(s *testserver.Server, id string)
		want  error
		clock func() time.Time
	}{
		{"rejected", func(s *testserver.Server, id string) { s.Reject(id) }, pairing.ErrRejected, nil},
		{"expired", nil, pairing.ErrExpired, func() time.Time { return time.Now().Add(16 * time.Minute) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := testserver.New()
			defer srv.Close()
			srv.AddCode("AAAA-BBBB")
			id, _ := identity.Generate()
			client := &pairing.Client{Origin: srv.Origin, HTTP: srv.Client()}
			resp, err := client.Pair(context.Background(), request(t, id, "AAAA-BBBB"), id.Fingerprint())
			if err != nil {
				t.Fatal(err)
			}
			if c.act != nil {
				c.act(srv, resp.ConnectorID)
			}
			if c.clock != nil {
				srv.Now = c.clock
			}
			client.Now = srv.Now
			if err := client.WaitForApproval(context.Background(), id, resp, noSleep); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestWaitForApprovalRetriesTransientFailures(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	id, _ := identity.Generate()
	direct := &pairing.Client{Origin: srv.Origin, HTTP: srv.Client()}
	resp, err := direct.Pair(context.Background(), request(t, id, "AAAA-BBBB"), id.Fingerprint())
	if err != nil {
		t.Fatal(err)
	}
	failures := 2
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failures > 0 {
			failures--
			w.Header().Set("Retry-After", "5")
			http.Error(w, `{"error":"slow down"}`, http.StatusTooManyRequests)
			return
		}
		srv.Approve(resp.ConnectorID)
		srv.Config.Handler.ServeHTTP(w, r)
	}))
	defer front.Close()
	srv.Origin, _ = pairing.NormaliseServer(front.URL)
	client := &pairing.Client{Origin: srv.Origin, HTTP: front.Client()}
	var waits []time.Duration
	sleep := func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	if err := client.WaitForApproval(context.Background(), id, resp, sleep); err != nil {
		t.Fatal(err)
	}
	if len(waits) != 3 || waits[0] != 2*time.Second || waits[1] < 5*time.Second {
		t.Fatalf("waits %v", waits)
	}
}

func TestPairRefusesFingerprintMismatch(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	id, _ := identity.Generate()
	other, _ := identity.Generate()
	c := &pairing.Client{Origin: srv.Origin, HTTP: srv.Client()}
	_, err := c.Pair(context.Background(), request(t, id, "AAAA-BBBB"), other.Fingerprint())
	if err == nil || !strings.Contains(err.Error(), "do not approve") {
		t.Fatalf("got %v", err)
	}
}

func TestClientNeverFollowsRedirects(t *testing.T) {
	hit := false
	elsewhere := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer elsewhere.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	origin, _ := pairing.NormaliseServer(redirector.URL)
	c := &pairing.Client{Origin: origin, HTTP: pairing.NewHTTPClient()}
	id, _ := identity.Generate()
	if _, err := c.Poll(context.Background(), id, "3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b"); err == nil {
		t.Fatal("a redirect was treated as success")
	}
	if hit {
		t.Fatal("the redirect was followed")
	}
}

func TestPairRejectsInvalidServerAnswers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"connectorId":"3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b","fingerprint":"x","status":"pending","pollAfterSeconds":2,"approveBy":"2026-10-03T09:45:00Z","extra":1}`))
	}))
	defer srv.Close()
	origin, _ := pairing.NormaliseServer(srv.URL)
	c := &pairing.Client{Origin: origin, HTTP: srv.Client()}
	id, _ := identity.Generate()
	if _, err := c.Pair(context.Background(), request(t, id, "AAAA-BBBB"), id.Fingerprint()); err == nil {
		t.Fatal("an answer with an unknown field was accepted")
	}
}
