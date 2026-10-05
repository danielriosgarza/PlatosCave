package jupyter

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"unicode/utf8"

	"parallax/connector/internal/protocol"
)

// maxKernelspecs is the number of kernels a report can carry (link.schema.json).
const maxKernelspecs = 32

var reKernelspecName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type specFields struct {
	DisplayName string `json:"display_name"`
	Language    string `json:"language"`
}

// serviceKernelspecs is the answer of GET /api/kernelspecs.
type serviceKernelspecs struct {
	Kernelspecs map[string]struct {
		Name string     `json:"name"`
		Spec specFields `json:"spec"`
	} `json:"kernelspecs"`
}

func (v serviceKernelspecs) list() []protocol.Kernelspec {
	m := map[string]specFields{}
	for name, k := range v.Kernelspecs {
		m[name] = k.Spec
	}
	return toKernelspecs(m)
}

// cliKernelspecs is the output of `jupyter kernelspec list --json`.
type cliKernelspecs struct {
	Kernelspecs map[string]struct {
		Spec specFields `json:"spec"`
	} `json:"kernelspecs"`
}

// ParseKernelspecList parses `jupyter kernelspec list --json`.
func ParseKernelspecList(out []byte) ([]protocol.Kernelspec, error) {
	var v cliKernelspecs
	if err := json.Unmarshal(out, &v); err != nil {
		return nil, fmt.Errorf("kernelspec list is not JSON: %w", err)
	}
	m := map[string]specFields{}
	for name, k := range v.Kernelspecs {
		m[name] = k.Spec
	}
	return toKernelspecs(m), nil
}

// toKernelspecs keeps well-formed names, clips the text fields and sorts by name.
func toKernelspecs(m map[string]specFields) []protocol.Kernelspec {
	out := []protocol.Kernelspec{}
	for name, s := range m {
		if !reKernelspecName.MatchString(name) {
			continue
		}
		out = append(out, protocol.Kernelspec{Name: name, DisplayName: clipRunes(cleanText(s.DisplayName), 128), Language: clipRunes(cleanText(s.Language), 32)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) > maxKernelspecs {
		out = out[:maxKernelspecs]
	}
	return out
}

// HasKernel reports whether specs lists name.
func HasKernel(specs []protocol.Kernelspec, name string) bool {
	for _, k := range specs {
		if k.Name == name {
			return true
		}
	}
	return false
}

// CLIKernelspecs runs `jupyter kernelspec list --json`, or `<python> -m jupyter kernelspec list
// --json` when an interpreter is chosen.
func CLIKernelspecs(ctx context.Context, python string) ([]protocol.Kernelspec, error) {
	out, err := runTool(ctx, python, "kernelspec", "list", "--json")
	if err != nil {
		return nil, err
	}
	return ParseKernelspecList(out)
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// cleanText drops control characters from text a tool printed.
func cleanText(s string) string {
	b := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 0x20 && r != 0x7f {
			b = append(b, r)
		}
	}
	return string(b)
}
