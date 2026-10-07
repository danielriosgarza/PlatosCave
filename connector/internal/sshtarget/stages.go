// Package sshtarget is the SSH half of the `ssh` target (docs/design/connector.md §5.1–5.3, §8):
// the dial through the network scope, an optional jump host reached as a direct-tcpip channel of
// the first connection, the host-identity table of §5.2 against the connector's own known_hosts,
// authentication by agent, key file and a keyboard-interactive second factor asked only in the
// connector's terminal, and the stages reachability, host_identity, ssh_auth, workspace and
// forwarding. The remote runtime (runtime, notebook_auth, kernels and Open) builds on the
// connection Check returns.
package sshtarget

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/target"
)

// Stage names Check reports, in order.
var Stages = []string{"reachability", "host_identity", "ssh_auth", "workspace", "forwarding"}

// Target holds what the SSH stages need on this computer.
type Target struct {
	// Dialer reaches the first hop inside the network scope; its Scope also classifies a jump
	// host's onward hop when that is an address literal.
	Dialer *netscope.Dialer
	// KnownHosts is the connector's own known_hosts file.
	KnownHosts *KnownHosts
	// Agent opens the SSH agent; nil means there is none.
	Agent AgentDialer
	// TTY is hello.features.tty: without it nothing is ever asked in a terminal.
	TTY bool
	// Terminal asks for passphrases and second factors when TTY is true.
	Terminal Terminal
	// Log receives one line per trust decision that wrote or refused a record.
	Log func(string)
	// Deadlines override design §5.1's stage deadlines, for tests.
	Deadlines map[string]time.Duration
	// PromptDeadline overrides ssh_auth's deadline once a terminal prompt starts, for tests.
	PromptDeadline time.Duration

	// Pinned makes KnownHosts the only record of trust, never written: a host it holds no key
	// for is host_key_untrusted_managed, and the server's records and confirmations are ignored
	// (a managed connector, design §12).
	Pinned bool
	// ManagedKey reads the key a `managed_key` reference names, and its certificate (nil when
	// there is none). Nil refuses `managed_key`; set, it is the only reference served.
	ManagedKey func(keyID string) (key, cert []byte, err error)
}

// Conn is an authenticated SSH connection to the target, through the jump host when there is
// one. Closing it closes both.
type Conn struct {
	Client *ssh.Client
	jump   *ssh.Client
}

// Close closes the target's connection and then the jump host's.
func (c *Conn) Close() error {
	err := c.Client.Close()
	if c.jump != nil {
		c.jump.Close()
	}
	return err
}

func (t *Target) deadline(s *target.Stages, name string) time.Duration {
	if d, ok := t.Deadlines[name]; ok {
		return d
	}
	return s.Deadline(name)
}

func (t *Target) promptDeadline() time.Duration {
	if t.PromptDeadline > 0 {
		return t.PromptDeadline
	}
	return target.PromptDeadline
}

// Check runs reachability, host_identity, ssh_auth, workspace and forwarding on s for an `ssh`
// target and returns the open connection when every one passed; the caller closes it. On a jump
// route each of the first three stages covers both hops within one deadline: the jump host is
// reached, identified and authenticated before the target can be reached through it, and a stage
// is reported once its last hop is done or a hop stopped the route. It creates nothing on the
// host and changes no record except a host key the decision table trusts.
func (t *Target) Check(ctx context.Context, req *protocol.TestConnection, s *target.Stages) *Conn {
	c := &checker{t: t, req: req, s: s}
	c.reach = newBudget("reachability", t.deadline(s, "reachability"))
	c.hostID = newBudget("host_identity", t.deadline(s, "host_identity"))
	c.auth = newBudget("ssh_auth", t.deadline(s, "ssh_auth"))
	conn := c.connect(ctx)
	if conn == nil {
		// Whatever stopped the route was reported; the stages after it are blocked.
		c.finishReach(nil, nil)
		c.finishHost(nil, nil)
		c.finishAuth(nil, nil)
		for _, name := range Stages[3:] {
			s.Finish(name, 0, nil, nil)
		}
		return nil
	}
	ok := c.stage(ctx, "workspace", func(ctx context.Context) (*protocol.StageData, error) {
		return checkWorkspace(ctx, conn.Client, req.Target.Workspace)
	})
	if ok {
		ok = c.stage(ctx, "forwarding", func(ctx context.Context) (*protocol.StageData, error) {
			return nil, checkForwarding(ctx, conn.Client)
		})
	} else {
		s.Finish("forwarding", 0, nil, nil)
	}
	if !ok {
		conn.Close()
		return nil
	}
	return conn
}

// checker runs the stages of one Check.
type checker struct {
	t   *Target
	req *protocol.TestConnection
	s   *target.Stages

	reach, hostID, auth *budget

	reachDone, hostDone, authDone bool
	// reached is the reachability report of the last hop reached.
	reached protocol.StageData
	// passed lists the hops whose key passed, jump host first.
	passed []protocol.HopKey
	// prompting counts terminal prompts waiting for an answer.
	prompting atomic.Int32
}

// stage runs a single-hop stage under its deadline.
func (c *checker) stage(ctx context.Context, name string, fn func(ctx context.Context) (*protocol.StageData, error)) bool {
	b := newBudget(name, c.t.deadline(c.s, name))
	var data *protocol.StageData
	err, expired := b.step(ctx, func(ctx context.Context) error {
		var err error
		data, err = fn(ctx)
		return err
	})
	if err != nil && (expired || ctx.Err() != nil) {
		err = target.DeadlineFailure(name, b.current())
	}
	return c.s.Finish(name, b.spent(), data, err)
}

func (c *checker) finishReach(data *protocol.StageData, err error) {
	if !c.reachDone {
		c.reachDone = true
		c.s.Finish("reachability", c.reach.spent(), data, err)
	}
}

// finishReached reports reachability as passed up to the last hop reached: on a jump route that
// stopped at the jump host, the stage passed for the jump host and the stop is reported by the
// stage that stopped it.
func (c *checker) finishReached() {
	d := c.reached
	c.finishReach(&d, nil)
}

func (c *checker) finishHost(extra *protocol.StageData, err error) {
	if c.hostDone {
		return
	}
	c.hostDone = true
	data := extra
	if len(c.passed) > 0 {
		if data == nil {
			data = &protocol.StageData{}
		}
		data.Hops = append([]protocol.HopKey(nil), c.passed...)
	}
	c.s.Finish("host_identity", c.hostID.spent(), data, err)
}

func (c *checker) finishAuth(data *protocol.StageData, err error) {
	if !c.authDone {
		c.authDone = true
		c.s.Finish("ssh_auth", c.auth.spent(), data, err)
	}
}

// stopped turns a step's error into its stage's failure: the stage's deadline code when the
// budget or the whole test ran out.
func stopped(err error, expired bool, ctx context.Context, b *budget) error {
	if expired || ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return target.DeadlineFailure(b.name, b.current())
	}
	return err
}

// connect runs the first three stages over every hop and returns the authenticated connection.
func (c *checker) connect(ctx context.Context) *Conn {
	req := c.req
	if req.Target.Kind != protocol.TargetSSH {
		c.finishReach(nil, &target.Failure{Code: protocol.CodeUnsupportedTarget, Detail: "not an ssh target"})
		return nil
	}
	if err := protocol.ValidateTarget(req.Target, req.Runtime, req.Confirmations); err != nil {
		c.finishReach(nil, &target.Failure{Code: protocol.CodeInvalidTarget, Detail: err.Error()})
		return nil
	}
	hops := route(req.Target)
	for _, h := range hops {
		managed := h.auth.Method == protocol.AuthManagedKey
		if managed && c.t.ManagedKey == nil {
			c.finishReach(nil, &target.Failure{Code: protocol.CodeUnsupportedTarget, Detail: "a managed key is used only by a managed connector"})
			return nil
		}
		if !managed && c.t.ManagedKey != nil {
			c.finishReach(nil, &target.Failure{Code: protocol.CodeUnsupportedTarget, Detail: "a managed connector uses only the keys of its own key store"})
			return nil
		}
	}
	if c.t.Dialer == nil || c.t.KnownHosts == nil {
		c.finishReach(nil, &target.Failure{Code: protocol.CodeInternal, Detail: "the connector has no SSH configuration"})
		return nil
	}
	var clients []*ssh.Client
	var via *ssh.Client
	for i, h := range hops {
		client := c.hop(ctx, h, via, i == len(hops)-1)
		if client == nil {
			for j := len(clients) - 1; j >= 0; j-- {
				clients[j].Close()
			}
			return nil
		}
		clients = append(clients, client)
		via = client
	}
	conn := &Conn{Client: via}
	if len(clients) == 2 {
		conn.jump = clients[0]
	}
	return conn
}

// hop reaches, identifies and authenticates one hop, charging each part to its stage, and
// reports every stage whose last part this hop was or that this hop stopped.
func (c *checker) hop(ctx context.Context, h hop, via *ssh.Client, last bool) *ssh.Client {
	var nc net.Conn
	var address string
	err, expired := c.reach.step(ctx, func(ctx context.Context) error {
		var err error
		nc, address, err = c.dialHop(ctx, h, via)
		return err
	})
	if err != nil {
		c.finishReach(&protocol.StageData{Hop: h.name}, stopped(err, expired, ctx, c.reach))
		return nil
	}
	c.reached = protocol.StageData{Hop: h.name, Address: address}
	if last {
		c.finishReached()
	}

	check, err := newHostCheck(c.t.KnownHosts, h, c.req, c.t.Log, c.t.Pinned)
	if err != nil {
		nc.Close()
		c.finishReached()
		c.finishHost(nil, &target.Failure{Code: protocol.CodeInternal, Detail: "the connector cannot read its known_hosts: " + err.Error()})
		return nil
	}
	authCtx, authCancel := context.WithCancel(ctx)
	defer authCancel()
	auth := &hopAuth{t: c.t, ctx: authCtx, tty: c.t.TTY, ref: h.auth, user: h.user, label: h.label()}
	if c.t.Terminal != nil {
		auth.term = &countingTerminal{Terminal: c.t.Terminal, n: &c.prompting}
	}
	auth.prompted = func() {
		c.auth.extend(c.t.promptDeadline())
		yes := true
		c.s.Running("ssh_auth", &protocol.StageData{Hop: h.name, TerminalPrompt: &yes})
	}
	defer auth.close()

	restrict := hostKeyAlgorithms(check.local)
	var hs *handshake
	err, expired = c.hostID.step(ctx, func(ctx context.Context) error {
		for {
			cfg := &ssh.ClientConfig{
				User:              h.user,
				Auth:              auth.methods(),
				HostKeyCallback:   check.callback,
				HostKeyAlgorithms: restrict,
			}
			hs = startHandshake(nc, endpointName(h.host, h.port), cfg)
			select {
			case <-check.decided:
				return nil
			case <-hs.done:
				select {
				case <-check.decided:
					return nil
				default:
				}
				if restrict != nil && isHostKeyNegotiation(hs.err) {
					// The host offers none of the key types recorded for it: ask again without
					// the restriction, so the key it does present is compared with the record.
					restrict = nil
					var err error
					if nc, _, err = c.dialHop(ctx, h, via); err != nil {
						return err
					}
					continue
				}
				return &target.Failure{Code: protocol.CodeConnectionRefused,
					Detail: fmt.Sprintf("the SSH key exchange with %s failed: %s", endpointName(h.host, h.port), firstLine(hs.err))}
			case <-ctx.Done():
				hs.abort()
				return ctx.Err()
			}
		}
	})
	if err != nil {
		if hs != nil {
			hs.abort()
		}
		c.finishReached()
		c.finishHost(nil, stopped(err, expired, ctx, c.hostID))
		return nil
	}
	passed, presented, failure, data := check.result()
	if !passed {
		hs.abort()
		c.finishReached()
		c.finishHost(data, failure)
		return nil
	}
	c.passed = append(c.passed, protocol.HopKey{Hop: h.name, Fingerprint: ssh.FingerprintSHA256(presented), Address: address})
	if last {
		c.finishHost(nil, nil)
	}

	// promptPending records whether a terminal prompt was waiting when the deadline came.
	var promptPending bool
	err, expired = c.auth.step(ctx, func(ctx context.Context) error {
		select {
		case <-hs.done:
			return hs.err
		case <-ctx.Done():
			promptPending = c.prompting.Load() > 0
			authCancel()
			hs.abort()
			return ctx.Err()
		}
	})
	if err != nil {
		hs.abort()
		var f error
		if expired || ctx.Err() != nil {
			f = target.DeadlineFailure("ssh_auth", c.auth.current())
			if promptPending {
				f = &target.Failure{Code: protocol.CodeMfaFailed, Detail: fmt.Sprintf("no answer was given in the connector's terminal for %s in time", h.label())}
			}
		} else {
			f = auth.failure(err)
		}
		c.finishReached()
		c.finishHost(nil, nil)
		c.finishAuth(&protocol.StageData{Hop: h.name}, f)
		return nil
	}
	client := ssh.NewClient(hs.conn, hs.chans, hs.reqs)
	if last {
		c.finishAuth(nil, nil)
	}
	return client
}

// countingTerminal counts the prompts waiting for an answer, so a deadline reached during one
// reports mfa_failed (design §5.1).
type countingTerminal struct {
	Terminal
	n *atomic.Int32
}

func (t *countingTerminal) Ask(ctx context.Context, prompt string, echo bool) ([]byte, error) {
	t.n.Add(1)
	defer t.n.Add(-1)
	return t.Terminal.Ask(ctx, prompt, echo)
}

// Workspace check exit statuses.
const (
	exitMissing     = 3
	exitNotDir      = 4
	exitNotWritable = 5
)

// workspaceScript checks the workspace and prints its canonical path. It runs under sh, because
// the account's login shell may be csh or tcsh, and it creates nothing.
const workspaceScript = `test -e "$1" || exit 3; test -d "$1" || exit 4; test -w "$1" || exit 5; cd -P -- "$1" && pwd -P`

// workspaceCommand is the command line of the workspace check: the fixed script, with the
// validated workspace as its only argument.
func workspaceCommand(workspace string) string {
	return "sh -c " + shellQuote(workspaceScript) + " sh " + shellQuote(workspace)
}

// maxOutput bounds what a check reads from a command.
const maxOutput = 16 << 10

// limitedBuffer keeps the first maxOutput bytes written to it.
type limitedBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := maxOutput - len(b.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		b.buf = append(b.buf, p[:room]...)
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// checkWorkspace is the workspace stage: the directory exists, is a directory and is writable,
// and its canonical path is reported. It is the connection's first exec, so a refused exec is
// remote_exec_denied.
func checkWorkspace(ctx context.Context, client *ssh.Client, workspace string) (*protocol.StageData, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, &target.Failure{Code: protocol.CodeRemoteExecDenied, Detail: "the host refused a session channel: " + firstLine(err)}
	}
	defer sess.Close()
	stop := context.AfterFunc(ctx, func() { sess.Close() })
	defer stop()
	var stdout, stderr limitedBuffer
	sess.Stdout, sess.Stderr = &stdout, &stderr
	if err := sess.Start(workspaceCommand(workspace)); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &target.Failure{Code: protocol.CodeRemoteExecDenied, Detail: "the host does not let this account run commands over SSH"}
	}
	err = sess.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var ee *ssh.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee) && ee.ExitStatus() == exitMissing:
		return nil, &target.Failure{Code: protocol.CodeWorkspaceMissing, Detail: workspace + " does not exist"}
	case errors.As(err, &ee) && ee.ExitStatus() == exitNotDir:
		return nil, &target.Failure{Code: protocol.CodeWorkspaceNotDirectory, Detail: workspace + " is not a directory"}
	case errors.As(err, &ee) && ee.ExitStatus() == exitNotWritable:
		return nil, &target.Failure{Code: protocol.CodeWorkspaceNotWritable, Detail: "the account cannot write to " + workspace}
	default:
		return nil, &target.Failure{Code: protocol.CodeInternal,
			Detail: fmt.Sprintf("the workspace check failed (%s): %s", firstLine(err), redact.Redact(lastLine(stderr.String())))}
	}
	resolved := lastLine(stdout.String())
	if !validPath(resolved) {
		return nil, &target.Failure{Code: protocol.CodeInternal, Detail: "the host did not report the workspace's canonical path"}
	}
	return &protocol.StageData{ResolvedPath: resolved}, nil
}

// lastLine is the last non-empty line of s: a login shell's profile may print lines first.
func lastLine(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\r\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimRight(lines[i], "\r"); l != "" {
			return l
		}
	}
	return ""
}

// validPath is an absolute POSIX path the protocol can carry.
func validPath(p string) bool {
	if !strings.HasPrefix(p, "/") || len(p) > 1024 {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Connect reaches, identifies and authenticates every hop of an `ssh` target, as the first three
// stages of Check do, and nothing more: the reconnect of design §5.5 and the orphan sweep of §6
// use it. A refusal is the *target.Failure of the stage that stopped the route.
func (t *Target) Connect(ctx context.Context, req *protocol.TestConnection) (*Conn, error) {
	s := &target.Stages{}
	c := &checker{t: t, req: req, s: s}
	c.reach = newBudget("reachability", t.deadline(s, "reachability"))
	c.hostID = newBudget("host_identity", t.deadline(s, "host_identity"))
	c.auth = newBudget("ssh_auth", t.deadline(s, "ssh_auth"))
	if conn := c.connect(ctx); conn != nil {
		return conn, nil
	}
	return nil, firstFailure(s.List)
}

// firstFailure is the failure of the first stage that failed or needs action.
func firstFailure(stages []protocol.Stage) *target.Failure {
	for _, st := range stages {
		if st.Status == "failed" || st.Status == "needs_action" {
			return &target.Failure{Code: st.Code, Detail: st.Detail, NeedsAction: st.Status == "needs_action"}
		}
	}
	return &target.Failure{Code: protocol.CodeInternal, Detail: "the SSH connection could not be made"}
}

// first is the connection to the first hop: the jump host's, or the target's when there is none.
func (c *Conn) first() *ssh.Client {
	if c.jump != nil {
		return c.jump
	}
	return c.Client
}
