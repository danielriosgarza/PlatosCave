// Package identity holds the connector's Ed25519 identity and builds the signed byte layouts of
// docs/design/connector.md §4.2. The key authenticates the connector to the one server it was
// paired with; it is not an SSH key.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Labels of the three signed messages (design §4.2), each followed by one 0x00 byte.
const (
	LinkLabel   = "parallax-connector-link-v1"
	PollLabel   = "parallax-connector-poll-v1"
	UnpairLabel = "parallax-connector-unpair-v1"
)

const pemType = "PRIVATE KEY"

// Identity is the connector's key pair.
type Identity struct {
	priv ed25519.PrivateKey
}

// Generate creates a new identity from the operating system's random source.
func Generate() (*Identity, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate identity: %w", err)
	}
	return &Identity{priv: priv}, nil
}

// FromSeed builds an identity from a 32-byte Ed25519 seed (used by the signing vectors).
func FromSeed(seed []byte) (*Identity, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("identity seed must be %d bytes, got %d", ed25519.SeedSize, len(seed))
	}
	return &Identity{priv: ed25519.NewKeyFromSeed(seed)}, nil
}

// MarshalPEM encodes the private key as PKCS #8 PEM, the format of identity.key.
func (id *Identity) MarshalPEM() ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(id.priv)
	if err != nil {
		return nil, fmt.Errorf("encode identity: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: pemType, Bytes: der}), nil
}

// ParsePEM decodes identity.key. Anything other than one PKCS #8 Ed25519 key is refused.
func ParsePEM(data []byte) (*Identity, error) {
	block, rest := pem.Decode(data)
	if block == nil || block.Type != pemType {
		return nil, errors.New("identity key is not a PKCS #8 PEM private key")
	}
	if len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("identity key file holds more than one PEM block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("identity key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("identity key is not an Ed25519 key")
	}
	return &Identity{priv: priv}, nil
}

// PublicKey returns the raw 32-byte public key.
func (id *Identity) PublicKey() ed25519.PublicKey {
	return id.priv.Public().(ed25519.PublicKey)
}

// PublicKeyBase64 returns the public key as unpadded base64url, the form of PairRequest.publicKey.
func (id *Identity) PublicKeyBase64() string {
	return base64.RawURLEncoding.EncodeToString(id.PublicKey())
}

// Fingerprint returns the fingerprint shown by `pair` and by the approval screen.
func (id *Identity) Fingerprint() string {
	return Fingerprint(id.PublicKey())
}

// Fingerprint is "SHA256:" plus the unpadded standard base64 of the SHA-256 of the raw public
// key. It is not an OpenSSH fingerprint (design §3).
func Fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ParseUUID returns the 16 raw bytes of a lower-case UUID.
func ParseUUID(s string) ([16]byte, error) {
	var out [16]byte
	if !uuidPattern.MatchString(s) {
		return out, fmt.Errorf("connector id %q is not a lower-case UUID", s)
	}
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil {
		return out, err
	}
	copy(out[:], b)
	return out, nil
}

// LinkMessage builds the bytes signed in answer to a link challenge.
func LinkMessage(nonce []byte, connectorID string, ts int64, origin string) ([]byte, error) {
	if len(nonce) != 32 {
		return nil, fmt.Errorf("challenge nonce must be 32 bytes, got %d", len(nonce))
	}
	return message(LinkLabel, nonce, connectorID, ts, origin)
}

// PollMessage builds the bytes signed by POST /api/connector/v1/pair/poll.
func PollMessage(connectorID string, ts int64, origin string) ([]byte, error) {
	return message(PollLabel, nil, connectorID, ts, origin)
}

// UnpairMessage builds the bytes signed by POST /api/connector/v1/unpair.
func UnpairMessage(connectorID string, ts int64, origin string) ([]byte, error) {
	return message(UnpairLabel, nil, connectorID, ts, origin)
}

func message(label string, nonce []byte, connectorID string, ts int64, origin string) ([]byte, error) {
	id, err := ParseUUID(connectorID)
	if err != nil {
		return nil, err
	}
	if len(origin) == 0 || len(origin) > 0xffff {
		return nil, fmt.Errorf("origin length %d is out of range", len(origin))
	}
	buf := make([]byte, 0, len(label)+1+len(nonce)+16+8+2+len(origin))
	buf = append(buf, label...)
	buf = append(buf, 0)
	buf = append(buf, nonce...)
	buf = append(buf, id[:]...)
	buf = binary.BigEndian.AppendUint64(buf, uint64(ts))
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(origin)))
	buf = append(buf, origin...)
	return buf, nil
}

// Sign signs a message built by one of the *Message functions.
func (id *Identity) Sign(msg []byte) []byte {
	return ed25519.Sign(id.priv, msg)
}

// SignLink signs a link challenge answer and returns the signature as unpadded base64url.
func (id *Identity) SignLink(nonce []byte, connectorID string, ts int64, origin string) (string, error) {
	msg, err := LinkMessage(nonce, connectorID, ts, origin)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(id.Sign(msg)), nil
}

// SignPoll signs a pairing poll and returns the signature as unpadded base64url.
func (id *Identity) SignPoll(connectorID string, ts int64, origin string) (string, error) {
	msg, err := PollMessage(connectorID, ts, origin)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(id.Sign(msg)), nil
}

// SignUnpair signs an unpair request and returns the signature as unpadded base64url.
func (id *Identity) SignUnpair(connectorID string, ts int64, origin string) (string, error) {
	msg, err := UnpairMessage(connectorID, ts, origin)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(id.Sign(msg)), nil
}

// Verify checks an unpadded base64url signature over msg with a raw public key.
func Verify(pub ed25519.PublicKey, msg []byte, sig string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || len(raw) != ed25519.SignatureSize || len(pub) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pub, msg, raw)
}
