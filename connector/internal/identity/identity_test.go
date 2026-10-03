package identity

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type signingVectors struct {
	Seed        string `json:"seed"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
	Origin      string `json:"origin"`
	ConnectorID string `json:"connectorId"`
	TS          int64  `json:"ts"`
	Nonce       string `json:"nonce"`
	Link        vector `json:"link"`
	Poll        vector `json:"poll"`
	Unpair      vector `json:"unpair"`
}

type vector struct {
	Message string `json:"message"`
	Sig     string `json:"sig"`
}

func loadVectors(t *testing.T) (signingVectors, *Identity) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", "v1", "vectors", "signing.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v signingVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(v.Seed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := FromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	return v, id
}

func TestFingerprintVector(t *testing.T) {
	v, id := loadVectors(t)
	if got := id.PublicKeyBase64(); got != v.PublicKey {
		t.Fatalf("public key = %s, want %s", got, v.PublicKey)
	}
	if got := id.Fingerprint(); got != v.Fingerprint {
		t.Fatalf("fingerprint = %s, want %s", got, v.Fingerprint)
	}
}

func TestSigningVectors(t *testing.T) {
	v, id := loadVectors(t)
	nonce, err := base64.RawURLEncoding.DecodeString(v.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	link, err := LinkMessage(nonce, v.ConnectorID, v.TS, v.Origin)
	if err != nil {
		t.Fatal(err)
	}
	poll, err := PollMessage(v.ConnectorID, v.TS, v.Origin)
	if err != nil {
		t.Fatal(err)
	}
	unpair, err := UnpairMessage(v.ConnectorID, v.TS, v.Origin)
	if err != nil {
		t.Fatal(err)
	}
	linkSig, _ := id.SignLink(nonce, v.ConnectorID, v.TS, v.Origin)
	pollSig, _ := id.SignPoll(v.ConnectorID, v.TS, v.Origin)
	unpairSig, _ := id.SignUnpair(v.ConnectorID, v.TS, v.Origin)

	for _, c := range []struct {
		name string
		msg  []byte
		sig  string
		want vector
	}{
		{"link", link, linkSig, v.Link},
		{"poll", poll, pollSig, v.Poll},
		{"unpair", unpair, unpairSig, v.Unpair},
	} {
		t.Run(c.name, func(t *testing.T) {
			want, err := hex.DecodeString(c.want.Message)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(c.msg, want) {
				t.Fatalf("message bytes\n got %x\nwant %x", c.msg, want)
			}
			if c.sig != c.want.Sig {
				t.Fatalf("signature = %s, want %s", c.sig, c.want.Sig)
			}
			if !Verify(id.PublicKey(), want, c.want.Sig) {
				t.Fatal("vector signature does not verify")
			}
			tampered := append([]byte(nil), want...)
			tampered[len(tampered)-1] ^= 1
			if Verify(id.PublicKey(), tampered, c.want.Sig) {
				t.Fatal("signature verifies over a changed origin")
			}
		})
	}
	// A signature for one purpose never verifies for another.
	if Verify(id.PublicKey(), unpair, pollSig) {
		t.Fatal("a poll signature verifies as an unpair signature")
	}
}

func TestIdentityPEMRoundTrip(t *testing.T) {
	id, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	pemBytes, err := id.MarshalPEM()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(pemBytes, []byte("-----BEGIN PRIVATE KEY-----\n")) {
		t.Fatalf("not PKCS #8 PEM: %q", pemBytes[:30])
	}
	back, err := ParsePEM(pemBytes)
	if err != nil {
		t.Fatal(err)
	}
	if back.Fingerprint() != id.Fingerprint() {
		t.Fatal("fingerprint changed through PEM round trip")
	}
	if _, err := ParsePEM(append(pemBytes, pemBytes...)); err == nil {
		t.Fatal("two PEM blocks were accepted")
	}
	if _, err := ParsePEM([]byte("not a key")); err == nil {
		t.Fatal("garbage was accepted")
	}
}

func TestMessageRejectsBadInputs(t *testing.T) {
	if _, err := PollMessage("3F2A6C1E-8B7D-4E5F-9A10-2C4D6E8F0A1B", 1, "https://x"); err == nil {
		t.Fatal("upper-case UUID accepted")
	}
	if _, err := LinkMessage(make([]byte, 31), "3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b", 1, "https://x"); err == nil {
		t.Fatal("short nonce accepted")
	}
	if _, err := PollMessage("3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b", 1, ""); err == nil {
		t.Fatal("empty origin accepted")
	}
}
