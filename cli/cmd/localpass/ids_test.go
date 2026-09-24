package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nawarian/localpass/cli/internal/store"
)

func TestSetAssignsAndKeepsEntryID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store.json")
	readPassword = func(fd int) ([]byte, error) { return []byte("pass"), nil }
	runInit([]string{"--store-path", path})
	runSet([]string{"github", "--store-path", path, "--password", "1", "--url", "", "--username", "", "--notes", "", "--meta", "x=y"})

	v, _ := store.LoadStore(path, "pass")
	id := v.Entries["github"].ID
	if id == "" {
		t.Fatal("new entry has no id")
	}

	stdin := os.Stdin
	r, w, _ := os.Pipe()
	w.WriteString("y\n")
	w.Close()
	os.Stdin = r
	resetStdinReader()
	defer func() { os.Stdin = stdin; resetStdinReader() }()
	runSet([]string{"github", "--store-path", path, "--password", "2", "--url", "", "--username", "", "--notes", "", "--meta", "x=y"})

	v, _ = store.LoadStore(path, "pass")
	if v.Entries["github"].ID != id || v.Entries["github"].Metadata["password"] != "2" {
		t.Fatalf("update should keep id %q, got %+v", id, v.Entries["github"])
	}
}
