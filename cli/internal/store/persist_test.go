package store

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadStore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.json")
	password := "myMasterPassword"

	vault := NewVault()
	vault.AddEntry("github", Entry{
		Metadata: map[string]string{
			"password": "secret",
			"url":      "https://github.com",
			"username": "user",
		},
	})

	if err := SaveStore(path, vault, password); err != nil {
		t.Fatalf("SaveStore error: %v", err)
	}

	loaded, err := LoadStore(path, password)
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}

	if loaded.Version != 1 {
		t.Errorf("expected version 1, got %d", loaded.Version)
	}

	entry, ok := loaded.GetEntry("github")
	if !ok {
		t.Fatal("expected entry 'github' to exist")
	}
	if entry.Metadata["password"] != "secret" {
		t.Errorf("expected password %q, got %q", "secret", entry.Metadata["password"])
	}
	if entry.Metadata["url"] != "https://github.com" {
		t.Errorf("expected URL %q, got %q", "https://github.com", entry.Metadata["url"])
	}
	if entry.Metadata["username"] != "user" {
		t.Errorf("expected username %q, got %q", "user", entry.Metadata["username"])
	}
}

func TestLoadNonExistentStore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.json")

	vault, err := LoadStore(path, "password")
	if err != nil {
		t.Fatalf("LoadStore error for non-existent file: %v", err)
	}
	if vault == nil {
		t.Fatal("expected non-nil vault")
	}
	if len(vault.Entries) != 0 {
		t.Errorf("expected empty vault, got %d entries", len(vault.Entries))
	}
}

func TestLoadCorruptedStore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "corrupted.json")

	if err := os.WriteFile(path, []byte("this is not encrypted data"), 0600); err != nil {
		t.Fatalf("write error: %v", err)
	}

	_, err := LoadStore(path, "password")
	if err == nil {
		t.Error("expected error for corrupted store, got nil")
	}
}

func TestSaveCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "sub", "store.json")
	password := "myMasterPassword"

	vault := NewVault()
	vault.AddEntry("key", Entry{Metadata: map[string]string{"password": "value"}})

	if err := SaveStore(path, vault, password); err != nil {
		t.Fatalf("SaveStore error: %v", err)
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("expected file to be created")
	}
}

func TestSaveAndLoadLargeVault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "large.json")
	password := "myMasterPassword"

	vault := NewVault()
	for i := 0; i < 1000; i++ {
		key := fmt.Sprintf("key-%04d", i)
		vault.AddEntry(key, Entry{
			Metadata: map[string]string{
				"password": fmt.Sprintf("password-%d", i),
				"url":      fmt.Sprintf("https://example-%d.com", i),
			},
		})
	}

	if err := SaveStore(path, vault, password); err != nil {
		t.Fatalf("SaveStore error: %v", err)
	}

	loaded, err := LoadStore(path, password)
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}

	if len(loaded.Entries) != 1000 {
		t.Errorf("expected 1000 entries, got %d", len(loaded.Entries))
	}
}

func TestAtomicWritePreservesOldFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "atomic.json")
	password := "myMasterPassword"

	vault1 := NewVault()
	vault1.AddEntry("key1", Entry{Metadata: map[string]string{"password": "value1"}})
	if err := SaveStore(path, vault1, password); err != nil {
		t.Fatalf("first SaveStore error: %v", err)
	}

	originalData, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}

	// Verify tmp file doesn't remain
	tmpPath := path + ".tmp"
	if _, err := os.Stat(tmpPath); err == nil {
		t.Error("tmp file should not exist after successful save")
	}

	loaded, err := LoadStore(path, password)
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	entry, ok := loaded.GetEntry("key1")
	if !ok || entry.Metadata["password"] != "value1" {
		t.Error("original data should be intact")
	}

	vault2 := NewVault()
	vault2.AddEntry("key2", Entry{Metadata: map[string]string{"password": "value2"}})
	if err := SaveStore(path, vault2, password); err != nil {
		t.Fatalf("second SaveStore error: %v", err)
	}

	loaded2, err := LoadStore(path, password)
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}
	if _, ok := loaded2.GetEntry("key1"); ok {
		t.Error("key1 should not exist after overwrite")
	}
	if _, ok := loaded2.GetEntry("key2"); !ok {
		t.Error("key2 should exist after overwrite")
	}

	newData, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	if len(newData) == 0 {
		t.Error("new file should not be empty")
	}
	_ = originalData
}

func TestLoadStoreWithWrongPassword(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wrongpass.json")

	vault := NewVault()
	vault.AddEntry("key", Entry{Metadata: map[string]string{"password": "value"}})

	if err := SaveStore(path, vault, "correctPassword"); err != nil {
		t.Fatalf("SaveStore error: %v", err)
	}

	_, err := LoadStore(path, "wrongPassword")
	if err == nil {
		t.Error("expected error for wrong password, got nil")
	}
}

func TestEmptyVaultRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	password := "myMasterPassword"

	vault := NewVault()
	if err := SaveStore(path, vault, password); err != nil {
		t.Fatalf("SaveStore error: %v", err)
	}

	loaded, err := LoadStore(path, password)
	if err != nil {
		t.Fatalf("LoadStore error: %v", err)
	}

	if len(loaded.Entries) != 0 {
		t.Errorf("expected empty vault, got %d entries", len(loaded.Entries))
	}
}
