package target

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const requestID = "c0ffee00-1111-4222-8333-444455556666"

func testReq(ws string, rt protocol.Runtime) *protocol.TestConnection {
	return &protocol.TestConnection{RequestID: requestID, Target: protocol.Target{Kind: protocol.TargetLocal, Workspace: ws}, Runtime: rt}
}

// runTest runs Local.Test and checks that progress reported every stage, in order, and that
// the result is a valid message.
func runTest(t *testing.T, req *protocol.TestConnection) *protocol.TestResult {
	t.Helper()
	l := &Local{OS: "linux", Arch: "amd64"}
	var progress []protocol.Stage
	res := l.Test(context.Background(), req, func(st protocol.Stage) { progress = append(progress, st) })
	if _, err := protocol.Encode(res); err != nil {
		t.Fatalf("invalid test_result: %v\n%+v", err, res)
	}
	for _, st := range progress {
		if _, err := protocol.Encode(&protocol.TestProgress{RequestID: requestID, Stage: st}); err != nil {
			t.Fatalf("invalid test_progress: %v", err)
		}
	}
	var names []string
	for i, st := range res.Stages {
		names = append(names, st.Name)
		if i >= len(progress) || progress[i].Name != st.Name || progress[i].Status != st.Status {
			t.Errorf("progress %d does not match the result's stage %s", i, st.Name)
		}
	}
	if got := strings.Join(names, ","); got != "workspace,runtime,notebook_auth,kernels" {
		t.Errorf("stages %s", got)
	}
	return res
}

func stage(res *protocol.TestResult, name string) protocol.Stage {
	for _, st := range res.Stages {
		if st.Name == name {
			return st
		}
	}
	return protocol.Stage{}
}

func expectStage(t *testing.T, res *protocol.TestResult, name, status string, code protocol.Code) protocol.Stage {
	t.Helper()
	st := stage(res, name)
	if st.Status != status || st.Code != code {
		t.Errorf("%s = %s/%s (%s), want %s/%s", name, st.Status, st.Code, st.Detail, status, code)
	}
	return st
}

func expectBlocked(t *testing.T, res *protocol.TestResult, by string, names ...string) {
	t.Helper()
	for _, n := range names {
		st := stage(res, n)
		if st.Status != "skipped" || st.Data == nil || st.Data.Reason != "blocked" || st.Data.BlockedBy != by {
			t.Errorf("%s = %+v, want skipped, blocked by %s", n, st, by)
		}
	}
}

func TestTestConnectionLocalStages(t *testing.T) {
	t.Run("start mode is ready to start and starts nothing", func(t *testing.T) {
		dir := jupytertest.Install(t, "")
		ws := t.TempDir()
		res := runTest(t, testReq(ws, protocol.Runtime{Mode: "start", KernelName: "python3"}))
		if res.Outcome != "ready_to_start" {
			t.Errorf("outcome %s", res.Outcome)
		}
		resolved, _ := filepath.EvalSymlinks(ws)
		if st := expectStage(t, res, "workspace", "ok", ""); st.Data == nil || st.Data.ResolvedPath != resolved {
			t.Errorf("workspace data %+v", st.Data)
		}
		if st := expectStage(t, res, "runtime", "ok", ""); st.Data == nil || st.Data.State != "startable" || st.Data.Version != jupytertest.Version {
			t.Errorf("runtime data %+v", st.Data)
		}
		if st := expectStage(t, res, "notebook_auth", "skipped", ""); st.Data == nil || st.Data.Reason != "not_started" {
			t.Errorf("notebook_auth data %+v", st.Data)
		}
		if st := expectStage(t, res, "kernels", "ok", ""); st.Data == nil || st.Data.Source != "cli" {
			t.Errorf("kernels data %+v", st.Data)
		}
		if len(res.Kernelspecs) != 2 || res.JupyterVersion != jupytertest.Version || res.Environment == nil || res.Environment.OS != "linux" {
			t.Errorf("result %+v", res)
		}
		if recs := jupytertest.Records(t, dir); len(recs) != 0 {
			t.Errorf("Test connection started %d servers", len(recs))
		}
		if entries, _ := os.ReadDir(ws); len(entries) != 0 {
			t.Errorf("Test connection wrote into the workspace: %v", entries)
		}
	})
	t.Run("with a chosen interpreter", func(t *testing.T) {
		dir := jupytertest.Install(t, "")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start", Python: jupytertest.Python(dir)}))
		if res.Outcome != "ready_to_start" || res.Environment.Runtime != "Python 3.12.8" {
			t.Errorf("outcome %s, environment %+v", res.Outcome, res.Environment)
		}
	})
	t.Run("an interpreter under ~/ is found in the home directory", func(t *testing.T) {
		dir := jupytertest.Install(t, "")
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		venv := filepath.Join(home, "venv", "bin")
		os.MkdirAll(venv, 0o700)
		name := filepath.Base(jupytertest.Python(dir))
		if err := os.Rename(jupytertest.Python(dir), filepath.Join(venv, name)); err != nil {
			t.Fatal(err)
		}
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start", Python: "~/venv/bin/" + name}))
		if res.Outcome != "ready_to_start" || res.Environment.Runtime != "Python 3.12.8" {
			t.Errorf("outcome %s: %+v", res.Outcome, res.Stages)
		}
	})
	t.Run("missing workspace blocks the rest", func(t *testing.T) {
		jupytertest.Install(t, "")
		res := runTest(t, testReq(filepath.Join(t.TempDir(), "nope"), protocol.Runtime{Mode: "start"}))
		expectStage(t, res, "workspace", "failed", protocol.CodeWorkspaceMissing)
		expectBlocked(t, res, "workspace", "runtime", "notebook_auth", "kernels")
		if res.Outcome != "failed" {
			t.Errorf("outcome %s", res.Outcome)
		}
	})
	t.Run("a file is not a workspace", func(t *testing.T) {
		jupytertest.Install(t, "")
		f := filepath.Join(t.TempDir(), "file")
		os.WriteFile(f, nil, 0o600)
		res := runTest(t, testReq(f, protocol.Runtime{Mode: "start"}))
		expectStage(t, res, "workspace", "failed", protocol.CodeWorkspaceNotDirectory)
	})
	t.Run("a read-only workspace", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root can write anywhere")
		}
		jupytertest.Install(t, "")
		ws := t.TempDir()
		os.Chmod(ws, 0o500)
		t.Cleanup(func() { os.Chmod(ws, 0o700) })
		res := runTest(t, testReq(ws, protocol.Runtime{Mode: "start"}))
		expectStage(t, res, "workspace", "failed", protocol.CodeWorkspaceNotWritable)
	})
	t.Run("jupyter missing", func(t *testing.T) {
		jupytertest.Install(t, "missing")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start"}))
		expectStage(t, res, "workspace", "ok", "")
		expectStage(t, res, "runtime", "failed", protocol.CodeJupyterMissing)
		expectBlocked(t, res, "runtime", "notebook_auth", "kernels")
	})
	t.Run("jupyter too old", func(t *testing.T) {
		jupytertest.Install(t, "old")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start"}))
		expectStage(t, res, "runtime", "failed", protocol.CodeJupyterIncompatible)
	})
	t.Run("interpreter that does not exist", func(t *testing.T) {
		jupytertest.Install(t, "")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start", Python: filepath.Join(t.TempDir(), "python9")}))
		expectStage(t, res, "runtime", "failed", protocol.CodeEnvironmentInvalid)
	})
	t.Run("chosen kernel not installed", func(t *testing.T) {
		jupytertest.Install(t, "")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start", KernelName: "julia-1.10"}))
		expectStage(t, res, "kernels", "failed", protocol.CodeKernelspecNotFound)
		if res.Outcome != "failed" {
			t.Errorf("outcome %s", res.Outcome)
		}
	})
	t.Run("attach to a live server is ready", func(t *testing.T) {
		ws, port, fake := attachFixture(t)
		res := runTest(t, testReq(ws, protocol.Runtime{Mode: "attach", Port: port, KernelName: "ir"}))
		if res.Outcome != "ready" {
			t.Errorf("outcome %s: %+v", res.Outcome, res.Stages)
		}
		if st := expectStage(t, res, "runtime", "ok", ""); st.Data == nil || st.Data.State != "running" {
			t.Errorf("runtime data %+v", st.Data)
		}
		expectStage(t, res, "notebook_auth", "ok", "")
		if st := expectStage(t, res, "kernels", "ok", ""); st.Data == nil || st.Data.Source != "service" {
			t.Errorf("kernels data %+v", st.Data)
		}
		if n := len(fake.Requests()); n == 0 {
			t.Error("the live server was not asked")
		}
	})
	t.Run("attach with a token Jupyter rejects", func(t *testing.T) {
		ws, port, _ := attachFixtureToken(t, "wrong-token-but-listed")
		res := runTest(t, testReq(ws, protocol.Runtime{Mode: "attach", Port: port}))
		expectStage(t, res, "notebook_auth", "failed", protocol.CodeTokenRejected)
		expectBlocked(t, res, "notebook_auth", "kernels")
	})
	t.Run("attach outside the server's root", func(t *testing.T) {
		_, port, _ := attachFixture(t)
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "attach", Port: port}))
		expectStage(t, res, "runtime", "failed", protocol.CodeWorkspaceOutsideRoot)
	})
	t.Run("attach with nothing running", func(t *testing.T) {
		jupytertest.Install(t, "")
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "attach", Port: closedPort(t)}))
		expectStage(t, res, "runtime", "failed", protocol.CodeAttachNoneFound)
	})
	t.Run("attach to a port nothing listens on", func(t *testing.T) {
		_, _, _ = attachFixture(t)
		res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "attach", Port: closedPort(t)}))
		expectStage(t, res, "runtime", "failed", protocol.CodeAttachPortUnreachable)
	})
	t.Run("attach to a server not on loopback", func(t *testing.T) {
		jupytertest.Install(t, "")
		ws := t.TempDir()
		t.Setenv(jupytertest.EnvList, fmt.Sprintf(`{"hostname": "0.0.0.0", "port": 18888, "pid": 7, "root_dir": %q, "token": "abcdabcd", "url": "http://0.0.0.0:18888/"}`, ws))
		res := runTest(t, testReq(ws, protocol.Runtime{Mode: "attach", Port: 18888}))
		expectStage(t, res, "runtime", "failed", protocol.CodeAttachNotLoopback)
	})
}

func TestAttachListsLoopbackOnlyInTestResult(t *testing.T) {
	jupytertest.Install(t, "")
	t.Setenv(jupytertest.EnvList, strings.Join([]string{
		`{"hostname": "127.0.0.1", "port": 8888, "pid": 4242, "root_dir": "/home/student", "token": "secret-token-1", "url": "http://127.0.0.1:8888/"}`,
		`{"hostname": "0.0.0.0", "port": 8890, "pid": 4244, "root_dir": "/srv", "token": "secret-token-2", "url": "http://0.0.0.0:8890/"}`,
		`{"hostname": "127.0.0.1", "port": 8892, "pid": 4246, "root_dir": "/home/student", "token": "", "url": "http://127.0.0.1:8892/"}`,
	}, "\n"))
	res := runTest(t, testReq(t.TempDir(), protocol.Runtime{Mode: "start"}))
	if len(res.Attachable) != 1 || res.Attachable[0].Port != 8888 || res.Attachable[0].RootDir != "/home/student" {
		t.Errorf("attachable %+v", res.Attachable)
	}
	data, _ := json.Marshal(res)
	if strings.Contains(string(data), "secret-token") {
		t.Error("a server's token is in the test result")
	}
}

func closedPort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

// attachFixture runs a fake Jupyter on loopback and lists it, with root_dir the parent of the
// returned workspace.
func attachFixture(t *testing.T) (string, int, *jupytertest.Server) {
	return attachFixtureToken(t, "")
}

func attachFixtureToken(t *testing.T, listedToken string) (string, int, *jupytertest.Server) {
	t.Helper()
	jupytertest.Install(t, "")
	fake := jupytertest.New("attach-token-0123456789")
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	root := t.TempDir()
	ws := filepath.Join(root, "parallax")
	os.Mkdir(ws, 0o700)
	if listedToken == "" {
		listedToken = fake.Token
	}
	t.Setenv(jupytertest.EnvList, fmt.Sprintf(`{"hostname": "127.0.0.1", "port": %d, "pid": %d, "root_dir": %q, "token": %q, "url": "http://127.0.0.1:%d/", "version": "2.21.1"}`,
		port, os.Getpid(), root, listedToken, port))
	return ws, port, fake
}

func TestOpenLocalStartWithInterpreterUnderHome(t *testing.T) {
	dir := jupytertest.Install(t, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	name := filepath.Base(jupytertest.Python(dir))
	os.MkdirAll(filepath.Join(home, "env"), 0o700)
	if err := os.Rename(jupytertest.Python(dir), filepath.Join(home, "env", name)); err != nil {
		t.Fatal(err)
	}
	l := &Local{OS: "linux", Arch: "amd64"}
	rt, err := l.Open(context.Background(), &protocol.OpenSession{RequestID: requestID, SessionID: requestID,
		Target: protocol.Target{Kind: "local", Workspace: t.TempDir()}, Runtime: protocol.Runtime{Mode: "start", Python: "~/env/" + name},
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Process.Stop(context.Background(), jupyter.DefaultStopTimes)
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 || recs[0].Argv[0] != filepath.Join(home, "env", name) {
		t.Errorf("started %+v", recs)
	}
}

func TestOpenLocalAttachIsNotOwned(t *testing.T) {
	ws, port, _ := attachFixture(t)
	l := &Local{OS: "linux", Arch: "amd64"}
	rt, err := l.Open(context.Background(), &protocol.OpenSession{RequestID: requestID, SessionID: requestID,
		Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: protocol.Runtime{Mode: "attach", Port: port},
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Release()
	if rt.Owned || rt.Process != nil || rt.Exited() != nil || rt.ContentRoot != "parallax" || len(rt.Kernelspecs) != 2 {
		t.Errorf("runtime %+v", rt)
	}
}

// TestA32_LocalAttachRedactsSharedToken (A32, attach mode): an attached server's token is
// redacted while any session attached to it is open, and only once the last one is released.
func TestA32_LocalAttachRedactsSharedToken(t *testing.T) {
	ws, port, fake := attachFixture(t)
	l := &Local{OS: "linux", Arch: "amd64"}
	open := func() *Runtime {
		rt, err := l.Open(context.Background(), &protocol.OpenSession{RequestID: requestID, SessionID: requestID,
			Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: protocol.Runtime{Mode: "attach", Port: port},
			Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
		if err != nil {
			t.Fatal(err)
		}
		return rt
	}
	line := "GET /api/kernels Authorization: token " + fake.Token
	if got := redact.Redact(line); !strings.Contains(got, fake.Token) {
		t.Fatalf("token redacted before any attach; the test proves nothing: %q", got)
	}
	first, second := open(), open()
	if got := redact.Redact(line); strings.Contains(got, fake.Token) {
		t.Fatalf("attached token left in %q", got)
	}
	first.Release()
	first.Release() // a second release of one session drops nothing more
	if got := redact.Redact(line); strings.Contains(got, fake.Token) {
		t.Fatalf("token unredacted while the second session still holds it: %q", got)
	}
	second.Release()
	if got := redact.Redact(line); !strings.Contains(got, fake.Token) {
		t.Fatalf("token still registered after both sessions were released: %q", got)
	}
}

func TestOpenLocalStartIsOwned(t *testing.T) {
	jupytertest.Install(t, "")
	ws := t.TempDir()
	l := &Local{OS: "linux", Arch: "amd64"}
	req := &protocol.OpenSession{RequestID: requestID, SessionID: requestID,
		Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: protocol.Runtime{Mode: "start", KernelName: "nope"},
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}}
	if _, err := l.Open(context.Background(), req); err == nil || !strings.Contains(err.Error(), string(protocol.CodeKernelspecNotFound)) {
		t.Fatalf("Open with a missing kernel: %v", err)
	}
	req.Runtime.KernelName = "python3"
	rt, err := l.Open(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Process.Stop(context.Background(), jupyter.DefaultStopTimes)
	if !rt.Owned || rt.ContentRoot != "" || rt.JupyterVersion != jupytertest.Version {
		t.Errorf("runtime %+v", rt)
	}
}
