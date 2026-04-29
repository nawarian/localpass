package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// LoadStore loads and decrypts a vault from the given file path.
// If the file does not exist, it returns an empty Vault (no error).
func LoadStore(path string, primaryPassword string) (*Vault, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewVault(), nil
		}
		return nil, fmt.Errorf("failed to read store file: %w", err)
	}

	plaintext, err := Decrypt(data, primaryPassword)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt store: %w", err)
	}

	var vault Vault
	if err := json.Unmarshal(plaintext, &vault); err != nil {
		return nil, fmt.Errorf("failed to unmarshal vault: %w", err)
	}

	if vault.Entries == nil {
		vault.Entries = make(map[string]Entry)
	}

	return &vault, nil
}

// SaveStore serializes, encrypts, and atomically writes the vault to the given file path.
func SaveStore(path string, vault *Vault, primaryPassword string) error {
	// Marshal to JSON
	data, err := json.Marshal(vault)
	if err != nil {
		return fmt.Errorf("failed to marshal vault: %w", err)
	}

	// Encrypt
	ciphertext, err := Encrypt(data, primaryPassword)
	if err != nil {
		return fmt.Errorf("failed to encrypt vault: %w", err)
	}

	// Ensure parent directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}

	// Atomic write: write to temp file first, then rename
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, ciphertext, 0600); err != nil {
		return fmt.Errorf("failed to write temp file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		// Clean up temp file on error
		os.Remove(tmpPath)
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	return nil
}
