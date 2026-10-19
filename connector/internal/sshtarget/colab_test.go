package sshtarget

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
	schemas "parallax/connector/protocol"
)

// colabRun is what one run of the fake colab program recorded.
type colabRun struct {
	Args, Env []string
	PID       int
}

// colabSecrets are what a colab program could print; none of them, nor any other byte the
// program writes, may reach a log line, a message or a detail.
var colabSecrets = []string{"https://accounts.example.org/signin?code=SECRETCODE&state=SECRETSTATE", "token=SECRETTOKEN",
	"Zq8vW3nR7tY2kP5mX9cB4dF6gH1jL0aS2eU7iO3p", "QX7K-M2PL", `{"access_token":"SECRETJSON"}`, "\x1b[2J\x1b]8;;x\x07"}

// colabNoise is 256 KiB of standard error, more than a pipe holds, with every secret planted and
// the short code also inside a sentence.
func colabNoise() []byte {
	unit := strings.Join(colabSecrets, "\n") + "\nEnter QX7K-M2PL to sign in.\n" + strings.Repeat("colab-noise ", 80) + "\n"
	return []byte(strings.Repeat(unit, 256<<10/len(unit)+1))
}

// runColabStub is the fake colab program: when the test binary runs as `colab` with a
// colab-stub.json beside it (the server's address, the records folder and a mode, because the
// connector filters the environment), it records its run, bridges its standard input and output
// to the in-process SSH server, and exits when either side ends. Mode "exit" writes colabNoise
// and an SSH 1 banner and exits 3, "stuck" the same but stays; "hang" starts a child and answers
// nothing; "noisy" starts a child and writes colabNoise while it bridges.
func runColabStub() {
	self, err := os.Executable()
	var cfg struct{ Addr, Records, Mode string }
	if err != nil || filepath.Base(self) != colabProgram {
		return
	} else if data, err := os.ReadFile(filepath.Join(filepath.Dir(self), "colab-stub.json")); err != nil || json.Unmarshal(data, &cfg) != nil {
		return
	}
	rec, _ := json.Marshal(colabRun{Args: os.Args, Env: os.Environ(), PID: os.Getpid()})
	os.WriteFile(filepath.Join(cfg.Records, "run-"+strconv.Itoa(os.Getpid())+".json"), rec, 0o600)
	if cfg.Mode == "exit" || cfg.Mode == "stuck" {
		os.Stderr.Write(colabNoise())
		os.Stdout.WriteString("SSH-1.0-SECRETBANNER\r\n")
		if cfg.Mode == "stuck" {
			time.Sleep(time.Hour)
		}
		os.Exit(3)
	} else if cfg.Mode != "" {
		exec.Command("/bin/sleep", "600").Start() // a process of its group, which must end with it
	}
	if cfg.Mode == "hang" {
		time.Sleep(time.Hour)
	}
	conn, err := net.Dial("tcp", cfg.Addr)
	if err != nil {
		os.Exit(3)
	}
	if cfg.Mode == "noisy" {
		go os.Stderr.Write(colabNoise())
	}
	go func() {
		io.Copy(conn, os.Stdin)
		os.Exit(0)
	}()
	io.Copy(os.Stdout, conn)
	os.Exit(0)
}

// newColabHost is the remote host behind the fake colab program, first on PATH, its key trusted
// under the trust name. It returns the folder the program's runs are recorded in.
func newColabHost(t *testing.T, mode string) (*remoteHost, ssh.Signer, string) {
	t.Helper()
	var hostKey ssh.Signer
	h := newRemoteHost(t, "", func(o *sshtest.Options) { hostKey = o.HostKeys[0] })
	h.f.trust(protocol.ColabHost, protocol.ColabPort, hostKey.PublicKey())
	h.f.tg.Colab = &Colab{}
	dir, records := t.TempDir(), t.TempDir()
	self, err := os.Executable()
	bin, err2 := os.ReadFile(self)
	cfg, _ := json.Marshal(map[string]string{"addr": h.srv.Addr, "records": records, "mode": mode})
	if err := errors.Join(err, err2, os.WriteFile(filepath.Join(dir, colabProgram), bin, 0o755),
		os.WriteFile(filepath.Join(dir, "colab-stub.json"), cfg, 0o600)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return h, hostKey, records
}

func colabRuns(t *testing.T, records string) []colabRun {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(records, "run-*.json"))
	runs := make([]colabRun, len(files))
	for i, f := range files {
		if data, err := os.ReadFile(f); err != nil || json.Unmarshal(data, &runs[i]) != nil {
			t.Fatalf("run record %s: %v", f, err)
		}
	}
	return runs
}

var colabCommand = []string{"colab", "ssh", "--proxy-mode"}

// TestA48_ColabRuntimeRunsACellThroughTheProxy (A48): a colab target passes the eight stages of
// A28 through one run of the colab program, its key trusted under colab.invalid with no address;
// Connect reuses that run and starts Jupyter in the workspace, a cell runs through the tunnel,
// and after Stop the server and the program have both exited.
func TestA48_ColabRuntimeRunsACellThroughTheProxy(t *testing.T) {
	h, hostKey, records := newColabHost(t, "")
	tg := protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: keyAuth(h.key), Workspace: h.ws}
	ctx := t.Context()
	res := h.r.Test(ctx, &protocol.TestConnection{RequestID: requestID, Target: tg, Runtime: h.start()}, func(protocol.Stage) {})
	want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=ok notebook_auth=skipped kernels=ok"
	if got := summary(res.Stages); res.Outcome != "ready_to_start" || got != want {
		t.Fatalf("outcome %s, stages %s\nwant %s", res.Outcome, got, want)
	}
	reach, hops := stageOf(t, res.Stages, "reachability").Data, stageOf(t, res.Stages, "host_identity").Data.Hops
	if reach == nil || reach.Hop != hopTarget || reach.Address != "" || len(hops) != 1 ||
		hops[0] != (protocol.HopKey{Hop: hopTarget, Fingerprint: ssh.FingerprintSHA256(hostKey.PublicKey())}) {
		t.Fatalf("reachability %+v, host_identity hops %+v", reach, hops)
	}

	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	rt, err := h.r.Open(ctx, &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: tg, Runtime: h.start(),
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	must(err)
	t.Cleanup(rt.Remote.Close)
	runs, recs := colabRuns(t, records), jupytertest.Records(t, h.stub)
	if len(runs) != 1 || !slices.Equal(runs[0].Args, colabCommand) || len(recs) != 1 || recs[0].Dir != h.ws {
		t.Fatalf("runs of the colab program %+v (want the tested one reused), servers %+v", runs, recs)
	}
	// print(2 + 2) on the kernel channel, through the tunnel.
	resp, err := rt.Client.Do(ctx, "POST", "/api/kernels", "", protocol.Headers{"content-type": "application/json"}, strings.NewReader(`{"name":"python3"}`), 18)
	must(err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	kernel, err := jupyter.KernelID(body)
	must(err)
	ws, err := rt.Client.DialChannel(ctx, "/api/kernels/"+kernel+"/channels", "session_id="+sessionID)
	must(err)
	req, _ := json.Marshal(map[string]any{"header": map[string]any{"msg_id": "m1", "msg_type": "execute_request"}, "content": map[string]any{"code": "print(2 + 2)"}, "channel": "shell"})
	must(ws.Write(ctx, websocket.MessageText, req))
	for out := ""; out != "4\n"; {
		_, data, err := ws.Read(ctx)
		must(err)
		var msg map[string]map[string]any // "channel" and "buffers" are not objects and stay out
		json.Unmarshal(data, &msg)
		if msg["header"]["msg_type"] == "stream" {
			out, _ = msg["content"]["text"].(string)
		}
	}
	ws.CloseNow()

	must(rt.Remote.Stop(ctx, jupyter.StopTimes{Shutdown: 5 * time.Second, Terminate: time.Second}))
	waitGone(t, recs[0].PID)
	waitGone(t, runs[0].PID)
}

// TestColabCommandNeverFromServer: no message can name the program, an argument or a command, and
// no value of a message reaches the program, in its arguments or its environment.
func TestColabCommandNeverFromServer(t *testing.T) {
	for name, field := range map[string]string{"s2c-test_connection-colab-proxy-command": "proxyCommand",
		"s2c-test_connection-colab-host": "host", "s2c-open_session-colab-program": "program"} {
		data, err := schemas.V1.ReadFile("v1/examples/invalid/" + name + ".json")
		var inv *protocol.InvalidError
		if _, err = protocol.Decode(data); !errors.As(err, &inv) || !strings.Contains(err.Error(), `"`+field+`"`) {
			t.Errorf("%s: Decode = %v, want an InvalidError naming %s", name, err, field)
		}
	}

	h, hostKey, records := newColabHost(t, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SSH_AUTH_SOCK", filepath.Join(home, "agent.sock"))
	t.Setenv("PARALLAX_CANARY", "canary-value")
	yes, other := true, "SHA256:CNmGQS0lbyFb7+gGOfxSjwhim0p2KZVFysYVlwS7Rws"
	second := protocol.Target{Kind: protocol.TargetColab, User: "x-ssh", Auth: &protocol.AuthRef{Method: protocol.AuthAgent, Hint: "--proxy-mode=x"},
		Workspace: "/tmp/$(touch pwned); colab ssh -o ProxyCommand=x",
		HostKeys:  []protocol.HostKey{{Host: protocol.ColabHost, Port: protocol.ColabPort, SHA256: ssh.FingerprintSHA256(hostKey.PublicKey())}}}
	for _, req := range []*protocol.TestConnection{
		{RequestID: requestID, Target: protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: keyAuth(h.key), Workspace: h.ws}, Runtime: h.start()},
		{RequestID: requestID, Target: second, Runtime: protocol.Runtime{Mode: protocol.RuntimeStart, Python: "/usr/bin/python3 -c x", Login: &yes},
			Confirmations: []protocol.Confirmation{{Host: protocol.ColabHost, Port: protocol.ColabPort, SHA256: other}}},
	} {
		if st := stageOf(t, h.r.Test(context.Background(), req, func(protocol.Stage) {}).Stages, "reachability"); st.Status != "ok" {
			t.Fatalf("reachability %+v", st)
		}
	}
	values := []string{h.ws, h.key.path, "x-ssh", "--proxy-mode=x", second.Workspace, "/usr/bin/python3 -c x", other, "canary-value"}
	runs := colabRuns(t, records)
	if len(runs) != 2 {
		t.Fatalf("%d runs of the colab program, want 2", len(runs))
	}
	for _, run := range runs {
		if !slices.Equal(run.Args, colabCommand) || !slices.Equal(run.Env, runs[0].Env) {
			t.Errorf("run %+v, want the arguments %q and the environment of %+v", run, colabCommand, runs[0])
		}
		for _, kv := range append(run.Env, run.Args...) {
			name, _, isVar := strings.Cut(kv, "=")
			if name == "SSH_AUTH_SOCK" || strings.HasPrefix(name, "PARALLAX_") || (isVar && !slices.Contains(colabEnv[:], name)) {
				t.Errorf("the program received %s", kv)
			}
			for _, v := range values {
				if strings.Contains(kv, v) {
					t.Errorf("the program received %q, which holds the message's value %q", kv, v)
				}
			}
		}
	}
	cwd, _ := os.Getwd()
	for _, dir := range []string{home, cwd, h.ws} {
		if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
			t.Errorf("a shell ran the workspace: %s/pwned exists", dir)
		}
	}
}
