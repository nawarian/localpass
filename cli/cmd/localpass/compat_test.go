package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nawarian/localpass/cli/internal/store"
)

func writeRawVault(t *testing.T, raw string) string {
	t.Helper()
	ct, err := store.Encrypt([]byte(raw), "pass")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "store.json")
	os.WriteFile(path, ct, 0600)
	return path
}

func TestSetKeepsFieldsFromNewerClients(t *testing.T) {
	path := writeRawVault(t, `{"version": 1, "entries": {"github": {"id": "abc", "metadata": {"password": "old"},
		"created_at": "2026-09-20T10:00:00Z", "updated_at": "2026-09-20T10:00:00Z"}}}`)
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }

	// Updating the entry answers the "already exists. Update?" prompt.
	stdin := os.Stdin
	r, w, _ := os.Pipe()
	w.WriteString("y\n")
	w.Close()
	os.Stdin = r
	resetStdinReader()
	defer func() { os.Stdin = stdin; resetStdinReader() }()

	runSet([]string{"github", "--store-path", path, "--password", "new", "--url", "", "--username", "", "--notes", "", "--meta", "x=y"})

	data, _ := os.ReadFile(path)
	plain, _ := store.Decrypt(data, "pass")
	var out struct {
		Entries map[string]map[string]any `json:"entries"`
	}
	json.Unmarshal(plain, &out)
	if out.Entries["github"]["id"] != "abc" {
		t.Fatalf("set dropped the entry's id: %s", plain)
	}
	if out.Entries["github"]["metadata"].(map[string]any)["password"] != "new" {
		t.Fatalf("set didn't apply: %s", plain)
	}
}

func TestSetRefusesNewerVault(t *testing.T) {
	path := writeRawVault(t, `{"version": 2, "entries": {}}`)
	before, _ := os.ReadFile(path)
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }

	stderrBuf := captureStderr(t)
	exitCode := 0
	oldOsExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("os.Exit")
	}
	defer func() { osExit = oldOsExit }()

	func() {
		defer func() { recover() }()
		runSet([]string{"github", "--store-path", path, "--password", "p", "--url", "", "--username", "", "--notes", "", "--meta", "x=y"})
	}()

	if exitCode != 1 {
		t.Fatalf("expected exit 1, got %d", exitCode)
	}
	if !strings.Contains(stderrBuf(), "update localpass") {
		t.Fatalf("expected an update hint, got %q", stderrBuf())
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("vault must be left untouched")
	}
}
