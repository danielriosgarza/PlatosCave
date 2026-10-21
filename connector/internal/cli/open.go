package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"parallax/connector/internal/opensite"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/state"
	"parallax/connector/internal/target"
	"parallax/connector/internal/version"
)

// allowOrigins collects repeated --allow ORIGIN flags.
type allowOrigins []string

func (a *allowOrigins) String() string { return strings.Join(*a, ",") }

func (a *allowOrigins) Set(v string) error {
	o, err := opensite.CanonicalOrigin(strings.TrimSpace(v))
	if err != nil {
		return fmt.Errorf("%s; give an origin such as https://course.example.org", err)
	}
	if len(*a) >= 16 {
		return errors.New("at most 16 --allow origins")
	}
	*a = append(*a, o)
	return nil
}

// openMode is `open` (docs/design/open-site.md §13): serve level 0 pages in this computer's
// browser on 127.0.0.1 until Ctrl+C, asking here before a site may run notebooks, and stop
// every Jupyter server it started on the way out. It needs no pairing and no state directory.
func openMode(ctx context.Context, args []string, env Env) error {
	flags := newFlags("open", env)
	workspace := flags.String("workspace", "~/Parallax", "folder below which each notebook gets a folder of its own")
	python := flags.String("python", "", "Python interpreter with Jupyter Server (default: jupyter from PATH)")
	var allow allowOrigins
	flags.Var(&allow, "allow", "allow this site without asking, such as https://course.example.org (repeatable)")
	if err := parse(flags, args); err != nil {
		return err
	}
	terminal := env.IsTerminal != nil && env.IsTerminal()
	if !terminal && len(allow) == 0 {
		return usageError{"open asks in a terminal before a site may run notebooks; run it in a terminal, or give --allow ORIGIN"}
	}
	root, err := state.ExpandHome(*workspace)
	if err != nil {
		return usageError{err.Error()}
	}
	if !filepath.IsAbs(root) {
		if root, err = filepath.Abs(root); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("the workspace %s cannot be created", root)
	}
	if root, err = filepath.EvalSymlinks(root); err != nil {
		return fmt.Errorf("the workspace %s cannot be read", root)
	}
	py := ""
	if *python != "" {
		if py, err = state.ExpandHome(*python); err != nil {
			return usageError{err.Error()}
		}
	}

	listen := env.Listen
	if listen == nil {
		listen = opensite.Listen
	}
	ln, err := listen(opensite.DefaultPort)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	out := env.Stdout
	cfg := opensite.Config{
		Port:   port,
		Root:   root,
		Python: py,
		Allow:  allow,
		Open: (&target.Local{
			OS: env.GOOS, Arch: env.GOARCH,
			Log: func(line string) { fmt.Fprintf(env.Stderr, "jupyter: %s\n", line) },
		}).Open,
		Log: out,
		Now: env.Now,
	}
	if terminal {
		a := newAsker(env.Stdin, out)
		cfg.Ask = func(ctx context.Context, origin, code string) opensite.Answer {
			a.drain()
			fmt.Fprintf(out, "\n%s asks to run notebooks on this computer, with your files and your Python.\n", origin)
			yes, answered := a.reply(ctx, fmt.Sprintf("The page shows the code %s. Allow this site until the connector stops?", code))
			switch {
			case yes:
				return opensite.Yes
			case answered:
				return opensite.No
			}
			return opensite.NoAnswer
		}
	}
	svc := opensite.New(ctx, cfg)
	srv := &http.Server{Handler: svc, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	fmt.Fprintf(out, "parallax-connector %s is open on http://127.0.0.1:%d for course pages in this computer's browser.\n", version.String(), port)
	fmt.Fprintf(out, "Each notebook gets a folder in %s.\n", root)
	for _, o := range allow {
		fmt.Fprintf(out, "Allowed without asking: %s\n", o)
	}
	fmt.Fprintln(out, "On a notebook's page, choose Run on this computer. Press Ctrl+C to stop.")

	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-served:
	}
	fmt.Fprintln(out, "Stopping the notebooks' Jupyter servers…")
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), exitBudget+10*time.Second)
	defer cancel()
	svc.Close(sctx)
	_ = srv.Shutdown(sctx)
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return errors.New(redact.Redact(serveErr.Error()))
	}
	fmt.Fprintln(out, "Stopped.")
	return nil
}
