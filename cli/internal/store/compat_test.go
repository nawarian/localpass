package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A vault as a newer client might write it: an unknown top-level field and
// an unknown field on each entry.
const newerVaultJSON = `{
  "version": 1,
  "sync_hint": {"device": "laptop"},
  "entries": {
    "github": {"id": "0b5f7c1e-8d0c-4c47-9b1f-6d2f0a7c9e11", "metadata": {"password": "a"},
               "created_at": "2026-09-20T10:00:00Z", "updated_at": "2026-09-20T10:00:00Z", "tags": ["dev"]},
    "gitlab": {"id": "7f1d2e3c-4b5a-4968-8776-655443322110", "metadata": {"password": "b"},
               "created_at": "2026-09-20T10:00:00Z", "updated_at": "2026-09-20T10:00:00Z"}
  }
}`

func writeVaultJSON(t *testing.T, raw string) string {
	t.Helper()
	ct, err := Encrypt([]byte(raw), "pass")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "store.json")
	if err := os.WriteFile(path, ct, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readVaultJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, _ := os.ReadFile(path)
	plain, err := Decrypt(data, "pass")
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(plain, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUnknownFieldsSurviveEditAndDelete(t *testing.T) {
	path := writeVaultJSON(t, newerVaultJSON)
	v, err := LoadStore(path, "pass")
	if err != nil {
		t.Fatal(err)
	}
	// Edit one entry the way `set` does (new Entry, Extra carried over), drop another.
	old := v.Entries["github"]
	v.AddEntry("github", Entry{Metadata: map[string]string{"password": "changed"}, CreatedAt: old.CreatedAt, UpdatedAt: time.Now(), Extra: old.Extra})
	v.DeleteEntry("gitlab")
	v.AddEntry("new", Entry{Metadata: map[string]string{"password": "n"}})
	if err := SaveStore(path, v, "pass"); err != nil {
		t.Fatal(err)
	}

	out := readVaultJSON(t, path)
	if hint, ok := out["sync_hint"].(map[string]any); !ok || hint["device"] != "laptop" {
		t.Fatalf("top-level unknown field lost: %v", out["sync_hint"])
	}
	github := out["entries"].(map[string]any)["github"].(map[string]any)
	if github["id"] != "0b5f7c1e-8d0c-4c47-9b1f-6d2f0a7c9e11" || github["tags"] == nil {
		t.Fatalf("entry unknown fields lost: %v", github)
	}
	if github["metadata"].(map[string]any)["password"] != "changed" {
		t.Fatalf("edit lost: %v", github)
	}
	if _, ok := out["entries"].(map[string]any)["gitlab"]; ok {
		t.Fatal("deleted entry came back")
	}
	if n := out["entries"].(map[string]any)["new"].(map[string]any); len(n) != 3 {
		t.Fatalf("new entry should only have the known fields, got %v", n)
	}
}

func TestKnownFieldsWinOverExtraWithSameName(t *testing.T) {
	e := Entry{Metadata: map[string]string{"k": "v"}, Extra: map[string]json.RawMessage{"metadata": json.RawMessage(`"bogus"`), "x": json.RawMessage(`1`)}}
	data, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var back Entry
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.Metadata["k"] != "v" || string(back.Extra["x"]) != "1" {
		t.Fatalf("round trip = %+v", back)
	}
}

func TestPlainVaultEncodesWithoutExtras(t *testing.T) {
	v := NewVault()
	v.AddEntry("a", Entry{Metadata: map[string]string{"password": "p"}})
	data, _ := json.Marshal(v)
	var out map[string]any
	json.Unmarshal(data, &out)
	if len(out) != 2 || len(out["entries"].(map[string]any)["a"].(map[string]any)) != 3 {
		t.Fatalf("unexpected fields: %s", data)
	}
}

func TestNewerVaultIsReadOnly(t *testing.T) {
	path := writeVaultJSON(t, `{"version": 2, "entries": {"a": {"metadata": {"password": "p"}}}}`)
	before, _ := os.ReadFile(path)

	v, err := LoadStore(path, "pass")
	if err != nil {
		t.Fatalf("a newer vault must still be readable: %v", err)
	}
	if v.Entries["a"].Metadata["password"] != "p" {
		t.Fatalf("read = %+v", v)
	}

	v.AddEntry("b", Entry{})
	var ve *VersionError
	if err := SaveStore(path, v, "pass"); !errors.As(err, &ve) || ve.Version != 2 {
		t.Fatalf("expected VersionError for v2, got %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("refused save must leave the file untouched")
	}
}
