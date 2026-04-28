package store

import (
	"sort"
	"strings"
	"time"
)

// Vault is the top-level container for password entries.
type Vault struct {
	Version int               `json:"version"`
	Entries map[string]Entry  `json:"entries"`
}

// Entry represents a single password entry.
// Common keys stored in Metadata:
//   "password"  - the password
//   "url"       - the URL
//   "username"  - the username
//   "notes"     - free-form notes/description
// Any other keys are treated as custom metadata (e.g. "OTP Secret", "recovery_code").
type Entry struct {
	Metadata  map[string]string `json:"metadata"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
}

// NewVault creates a new empty vault with Version set to 1.
func NewVault() *Vault {
	return &Vault{
		Version: 1,
		Entries: make(map[string]Entry),
	}
}

// AddEntry adds or updates an entry for the given key.
func (v *Vault) AddEntry(key string, entry Entry) {
	if v.Entries == nil {
		v.Entries = make(map[string]Entry)
	}
	v.Entries[key] = entry
}

// GetEntry retrieves an entry by key.
func (v *Vault) GetEntry(key string) (Entry, bool) {
	entry, ok := v.Entries[key]
	return entry, ok
}

// DeleteEntry removes an entry by key.
func (v *Vault) DeleteEntry(key string) {
	delete(v.Entries, key)
}

// ListKeys returns all keys in the vault, sorted alphabetically.
func (v *Vault) ListKeys() []string {
	keys := make([]string, 0, len(v.Entries))
	for k := range v.Entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Search returns keys that contain the query string (case-insensitive).
func (v *Vault) Search(query string) []string {
	query = strings.ToLower(query)
	var result []string
	for k := range v.Entries {
		if strings.Contains(strings.ToLower(k), query) {
			result = append(result, k)
		}
	}
	sort.Strings(result)
	return result
}
