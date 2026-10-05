package link

import (
	"fmt"
	"time"
)

// State is the link state reported to `run` and written to runtime.json.
type State string

// Link states (state.schema.json#/$defs/Runtime `link`).
const (
	Connecting     State = "connecting"
	Authenticating State = "authenticating"
	Up             State = "up"
	Down           State = "down"
	Pending        State = "pending"
	Revoked        State = "revoked"
	Rejected       State = "rejected"
)

// Close codes of design §4.6.
const (
	CloseNormal           = 1000
	CloseGoingAway        = 1001
	CloseProtocolError    = 4400
	CloseUnauthorized     = 4401
	CloseForbidden        = 4403
	CloseHeartbeatTimeout = 4408
	CloseReplaced         = 4409
	CloseUpgradeRequired  = 4426
	CloseRateLimited      = 4429
	CloseServerError      = 4500
)

// Close reasons that change what the connector does.
const (
	ReasonBadSignature = "bad_signature"
	ReasonClockSkew    = "clock_skew"
	ReasonPending      = "pending"
	ReasonRevoked      = "revoked"
	ReasonModeMismatch = "mode_mismatch"
)

// Fixed waits of design §4.6, in protocol seconds.
const (
	pendingRetry   = 10
	clockSkewRetry = 30
	replacedWait   = 60
	backoffBase    = 1
	backoffCap     = 60
	stableAfter    = 60 // a link up this long resets the backoff
)

// action is what the connector does after a link ends.
type action struct {
	stop  bool   // do not redial; Run returns a *StopError
	state State  // state to report
	wait  int    // fixed wait in protocol seconds (0: use the backoff)
	msg   string // what to tell the person
}

// decide maps a close code and reason to the reaction of design §4.6. code is -1 when the link
// failed without a close frame (network error, refused dial).
func decide(code int, reason, minVersion string) action {
	switch code {
	case CloseUnauthorized:
		if reason == ReasonClockSkew {
			return action{state: Down, wait: clockSkewRetry,
				msg: "Parallax says this computer's clock is wrong; retrying every 30 s. Check the date and time settings"}
		}
		return action{stop: true, state: Rejected,
			msg: "Parallax did not accept this computer's signature: the device is unknown or its identity was replaced. " +
				"Run `parallax-connector doctor`, or pair again"}
	case CloseForbidden:
		switch reason {
		case ReasonPending:
			return action{state: Pending, wait: pendingRetry,
				msg: "Waiting for this computer to be approved in Parallax; retrying every 10 s"}
		case ReasonRevoked:
			return action{stop: true, state: Revoked,
				msg: "This computer was revoked in Parallax. To use it again, pair it again with `parallax-connector pair --force`"}
		case ReasonModeMismatch:
			return action{stop: true, state: Rejected,
				msg: "Parallax registered this connector in another mode than its configuration says; pair it again"}
		}
		return action{state: Down, msg: fmt.Sprintf("Parallax refused the link (%s)", reasonOr(reason, "forbidden"))}
	case CloseUpgradeRequired:
		need := "a newer version"
		if minVersion != "" {
			need = "version " + minVersion + " or later"
		}
		return action{stop: true, state: Rejected,
			msg: "Parallax requires parallax-connector " + need + ". Install it and run `parallax-connector run` again"}
	case CloseReplaced:
		return action{state: Down, wait: replacedWait,
			msg: "Another parallax-connector with this identity connected and replaced this link; waiting 60 s before trying again"}
	case CloseRateLimited:
		return action{state: Down, msg: "Parallax is limiting connection attempts; backing off"}
	case CloseProtocolError:
		return action{state: Down, msg: "The link ended with a protocol error; reconnecting. If this repeats, update parallax-connector"}
	case CloseHeartbeatTimeout:
		return action{state: Down, msg: "The link stopped answering; reconnecting"}
	case CloseGoingAway:
		return action{state: Down, msg: "Parallax restarted; reconnecting"}
	}
	return action{state: Down, msg: "The link to Parallax is down; reconnecting"}
}

func reasonOr(reason, fallback string) string {
	if reason == "" {
		return fallback
	}
	return reason
}

// Backoff is exponential backoff with full jitter: attempt n waits a uniformly random duration
// in [0, min(Cap, Base·2ⁿ)].
type Backoff struct {
	Base, Cap time.Duration
	// Rand returns a uniformly random int64 in [0, n).
	Rand    func(n int64) int64
	attempt int
}

// Next returns the wait before the next attempt and advances the backoff.
func (b *Backoff) Next() time.Duration {
	ceiling := b.Ceiling()
	if b.attempt < 32 {
		b.attempt++
	}
	return time.Duration(b.Rand(int64(ceiling) + 1))
}

// Ceiling is the largest wait the next call to Next may return.
func (b *Backoff) Ceiling() time.Duration {
	d := b.Base << b.attempt
	if d > b.Cap || d <= 0 {
		d = b.Cap
	}
	return d
}

// Reset starts again from Base, after a link stayed up long enough.
func (b *Backoff) Reset() { b.attempt = 0 }
