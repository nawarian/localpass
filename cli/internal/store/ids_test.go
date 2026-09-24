package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNewIDIsUniqueUUIDv4(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := NewID()
		if !uuidV4.MatchString(id) || seen[id] {
			t.Fatalf("bad or repeated id %q", id)
		}
		seen[id] = true
	}
}

func TestEnsureIDs(t *testing.T) {
	v := NewVault()
	v.AddEntry("keep", Entry{ID: "kept-id"})
	v.AddEntry("missing", Entry{})
	v.AddEntry("a-dup", Entry{ID: "dup"})
	v.AddEntry("b-dup", Entry{ID: "dup"})
	v.EnsureIDs()

	if v.Entries["keep"].ID != "kept-id" {
		t.Fatalf("an existing unique id must not change: %q", v.Entries["keep"].ID)
	}
	if !uuidV4.MatchString(v.Entries["missing"].ID) {
		t.Fatalf("missing id not assigned: %q", v.Entries["missing"].ID)
	}
	if v.Entries["a-dup"].ID != "dup" || v.Entries["b-dup"].ID == "dup" {
		t.Fatalf("the first duplicate by name keeps the id, the other gets a new one: %q %q", v.Entries["a-dup"].ID, v.Entries["b-dup"].ID)
	}
}

func TestIDsAreStableAcrossSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store.json")
	v := NewVault()
	v.AddEntry("github", Entry{Metadata: map[string]string{"password": "p"}})
	if err := SaveStore(path, v, "pass"); err != nil {
		t.Fatal(err)
	}
	first := v.Entries["github"].ID
	if !uuidV4.MatchString(first) {
		t.Fatalf("SaveStore should assign an id, got %q", first)
	}

	again, _ := LoadStore(path, "pass")
	SaveStore(path, again, "pass")
	back, _ := LoadStore(path, "pass")
	if back.Entries["github"].ID != first {
		t.Fatalf("id changed across saves: %q -> %q", first, back.Entries["github"].ID)
	}
}

// A client that predates IDs drops them from entries it rewrites. The next
// save by a current client gives those entries a new ID and leaves the
// others alone: IDs can be lost that way, entries never.
func TestOldClientDroppingIDsLosesNoEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store.json")
	v := NewVault()
	v.AddEntry("a", Entry{Metadata: map[string]string{"password": "1"}})
	v.AddEntry("b", Entry{Metadata: map[string]string{"password": "2"}})
	SaveStore(path, v, "pass")
	idA, idB := v.Entries["a"].ID, v.Entries["b"].ID

	// What an old client writes after editing "a": no id on it.
	data, _ := os.ReadFile(path)
	plain, _ := Decrypt(data, "pass")
	var raw map[string]any
	json.Unmarshal(plain, &raw)
	delete(raw["entries"].(map[string]any)["a"].(map[string]any), "id")
	plain, _ = json.Marshal(raw)
	ct, _ := Encrypt(plain, "pass")
	os.WriteFile(path, ct, 0600)

	back, _ := LoadStore(path, "pass")
	SaveStore(path, back, "pass")
	back, _ = LoadStore(path, "pass")
	if len(back.Entries) != 2 {
		t.Fatalf("entries lost: %v", back.ListKeys())
	}
	if back.Entries["b"].ID != idB {
		t.Fatal("untouched entry's id changed")
	}
	if id := back.Entries["a"].ID; id == "" || id == idA {
		t.Fatalf("stripped entry should get a fresh id, got %q", id)
	}
}
