package redact

import (
	"strings"
	"testing"
)

func TestRedactTokenQueryValues(t *testing.T) {
	var r Redactor
	cases := map[string]string{
		"http://127.0.0.1:8888/lab?token=abc123def":             "http://127.0.0.1:8888/lab?token=" + Placeholder,
		"see http://localhost:8888/?foo=1&token=Zz9-x_y done":   "see http://localhost:8888/?foo=1&token=" + Placeholder + " done",
		"GET /api/kernels?access_token=s3cr3t&x=1":              "GET /api/kernels?access_token=" + Placeholder + "&x=1",
		`"url": "http://127.0.0.1:9000/?TOKEN=ABCDEF"`:          `"url": "http://127.0.0.1:9000/?TOKEN=` + Placeholder + `"`,
		"no secrets here, token is a word; tokens=3 is a count": "no secrets here, token is a word; tokens=3 is a count",
	}
	for in, want := range cases {
		if got := r.Redact(in); got != want {
			t.Errorf("Redact(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestRedactRegisteredSecrets(t *testing.T) {
	var r Redactor
	r.Register("hunter2-passphrase")
	r.Register("hunter2")
	r.Register("abc") // too short to be a secret; ignored
	got := r.Redact("pass=hunter2-passphrase other=hunter2 abc")
	if strings.Contains(got, "hunter2") {
		t.Fatalf("secret left in %q", got)
	}
	if want := "pass=" + Placeholder + " other=" + Placeholder + " abc"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	r.Forget("hunter2")
	if got := r.Redact("hunter2"); got != "hunter2" {
		t.Fatalf("forgotten secret still redacted: %q", got)
	}
}

func TestProcessWideRedactor(t *testing.T) {
	Register("process-wide-secret")
	defer Forget("process-wide-secret")
	if got := Redact("x process-wide-secret y"); got != "x "+Placeholder+" y" {
		t.Fatalf("got %q", got)
	}
}

// TestA32_SharedSecretStaysRedactedUntilLastForget (A32, attach mode): two sessions attached to
// one Jupyter server register its token twice; the first to close must not unredact it.
func TestA32_SharedSecretStaysRedactedUntilLastForget(t *testing.T) {
	var r Redactor
	const token = "shared-jupyter-token-0123"
	r.Register(token)
	r.Register(token)
	r.Forget(token)
	if got := r.Redact("log " + token); got != "log "+Placeholder {
		t.Fatalf("token unredacted while another session still holds it: %q", got)
	}
	r.Forget(token)
	if got := r.Redact("log " + token); got != "log "+token {
		t.Fatalf("token still redacted after its last reference was dropped: %q", got)
	}
	r.Forget(token) // one Forget too many is harmless
	r.Register(token)
	if got := r.Redact(token); got != Placeholder {
		t.Fatalf("an extra Forget left a debt against a later registration: %q", got)
	}
}
