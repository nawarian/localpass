package store

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNewVault(t *testing.T) {
	v := NewVault()
	if v.Version != 1 {
		t.Errorf("expected version 1, got %d", v.Version)
	}
	if v.Entries == nil {
		t.Error("expected non-nil entries map")
	}
	if len(v.Entries) != 0 {
		t.Errorf("expected empty entries, got %d", len(v.Entries))
	}
}

func TestAddAndGetEntry(t *testing.T) {
	v := NewVault()
	now := time.Now()
	entry := Entry{
		Metadata: map[string]string{
			"password": "supersecret",
			"url":      "https://example.com",
			"username": "user@example.com",
			"notes":    "test entry",
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	v.AddEntry("example", entry)

	got, ok := v.GetEntry("example")
	if !ok {
		t.Fatal("expected entry to exist")
	}
	if got.Metadata["password"] != "supersecret" {
		t.Errorf("expected password %q, got %q", "supersecret", got.Metadata["password"])
	}
	if got.Metadata["url"] != "https://example.com" {
		t.Errorf("expected url %q, got %q", "https://example.com", got.Metadata["url"])
	}
}

func TestDeleteEntry(t *testing.T) {
	v := NewVault()
	v.AddEntry("example", Entry{Metadata: map[string]string{"password": "secret"}})
	v.DeleteEntry("example")
	_, ok := v.GetEntry("example")
	if ok {
		t.Error("expected entry to be deleted")
	}
}

func TestListKeys(t *testing.T) {
	v := NewVault()
	v.AddEntry("b", Entry{Metadata: map[string]string{"password": "b"}})
	v.AddEntry("a", Entry{Metadata: map[string]string{"password": "a"}})
	v.AddEntry("c", Entry{Metadata: map[string]string{"password": "c"}})

	keys := v.ListKeys()
	expected := []string{"a", "b", "c"}
	if len(keys) != len(expected) {
		t.Fatalf("expected %d keys, got %d: %v", len(expected), len(keys), keys)
	}
	for i, k := range keys {
		if k != expected[i] {
			t.Errorf("key[%d] = %q, want %q", i, k, expected[i])
		}
	}
}

func TestSearch(t *testing.T) {
	v := NewVault()
	v.AddEntry("github", Entry{Metadata: map[string]string{"password": "g"}})
	v.AddEntry("gitlab", Entry{Metadata: map[string]string{"password": "gl"}})
	v.AddEntry("email", Entry{Metadata: map[string]string{"password": "e"}})

	results := v.Search("git")
	expected := []string{"github", "gitlab"}
	if len(results) != len(expected) {
		t.Fatalf("expected %d results, got %d: %v", len(expected), len(results), results)
	}
	for i, k := range results {
		if k != expected[i] {
			t.Errorf("result[%d] = %q, want %q", i, k, expected[i])
		}
	}
}

func TestSearchCaseInsensitive(t *testing.T) {
	v := NewVault()
	v.AddEntry("GitHub", Entry{Metadata: map[string]string{"password": "g"}})
	v.AddEntry("GITLAB", Entry{Metadata: map[string]string{"password": "gl"}})

	results := v.Search("git")
	if len(results) != 2 {
		t.Errorf("expected 2 results, got %d: %v", len(results), results)
	}
}

func TestJSONRoundTrip(t *testing.T) {
	v := NewVault()
	now := time.Now().UTC().Truncate(time.Second)
	v.AddEntry("example", Entry{
		Metadata: map[string]string{
			"password": "secret",
			"url":      "https://example.com",
			"username": "user",
			"notes":    "notes",
		},
		CreatedAt: now,
		UpdatedAt: now,
	})

	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var v2 Vault
	if err := json.Unmarshal(data, &v2); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if v2.Version != v.Version {
		t.Errorf("version mismatch: %d vs %d", v2.Version, v.Version)
	}

	e1 := v.Entries["example"]
	e2 := v2.Entries["example"]

	if e2.Metadata["password"] != e1.Metadata["password"] {
		t.Errorf("password mismatch: %q vs %q", e2.Metadata["password"], e1.Metadata["password"])
	}
	if e2.Metadata["url"] != e1.Metadata["url"] {
		t.Errorf("url mismatch: %q vs %q", e2.Metadata["url"], e1.Metadata["url"])
	}
	if !e2.CreatedAt.Equal(e1.CreatedAt) {
		t.Errorf("created_at mismatch: %v vs %v", e2.CreatedAt, e1.CreatedAt)
	}
	if !e2.UpdatedAt.Equal(e1.UpdatedAt) {
		t.Errorf("updated_at mismatch: %v vs %v", e2.UpdatedAt, e1.UpdatedAt)
	}
}

func TestGetNonexistentEntry(t *testing.T) {
	v := NewVault()
	_, ok := v.GetEntry("nonexistent")
	if ok {
		t.Error("expected false for nonexistent entry")
	}
}

func TestDeleteNonexistentEntry(t *testing.T) {
	v := NewVault()
	// Should not panic
	v.DeleteEntry("nonexistent")
}

func TestListKeysEmpty(t *testing.T) {
	v := NewVault()
	keys := v.ListKeys()
	if len(keys) != 0 {
		t.Errorf("expected empty keys, got %v", keys)
	}
}

func TestSearchEmpty(t *testing.T) {
	v := NewVault()
	results := v.Search("anything")
	if len(results) != 0 {
		t.Errorf("expected empty results, got %v", results)
	}
}

func TestRoundTripCustomMetadata(t *testing.T) {
	v := NewVault()
	now := time.Now().UTC().Truncate(time.Second)
	v.AddEntry("mykey", Entry{
		Metadata: map[string]string{
			"password":       "s3cret",
			"OTP Secret":     "JBSWY3DPEHPK3PXP",
			"recovery_code":  "abcd-1234",
			"totp_algorithm": "SHA1",
		},
		CreatedAt: now,
		UpdatedAt: now,
	})

	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var v2 Vault
	if err := json.Unmarshal(data, &v2); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	e2 := v2.Entries["mykey"]
	if e2.Metadata["OTP Secret"] != "JBSWY3DPEHPK3PXP" {
		t.Errorf("expected OTP Secret %q, got %q", "JBSWY3DPEHPK3PXP", e2.Metadata["OTP Secret"])
	}
	if e2.Metadata["recovery_code"] != "abcd-1234" {
		t.Errorf("expected recovery_code %q, got %q", "abcd-1234", e2.Metadata["recovery_code"])
	}
	if e2.Metadata["totp_algorithm"] != "SHA1" {
		t.Errorf("expected totp_algorithm %q, got %q", "SHA1", e2.Metadata["totp_algorithm"])
	}
}

func TestEntryWithNoMetadata(t *testing.T) {
	v := NewVault()
	now := time.Now().UTC().Truncate(time.Second)
	v.AddEntry("empty", Entry{
		Metadata:  map[string]string{},
		CreatedAt: now,
		UpdatedAt: now,
	})

	entry, ok := v.GetEntry("empty")
	if !ok {
		t.Fatal("expected entry to exist")
	}
	if len(entry.Metadata) != 0 {
		t.Errorf("expected empty metadata, got %d keys", len(entry.Metadata))
	}
}
