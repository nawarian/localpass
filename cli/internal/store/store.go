package store

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// Vault is the top-level container for password entries.
// It's (un)marshaled by the methods in compat.go.
type Vault struct {
	Version int
	Entries map[string]Entry
	// Extra holds top-level fields written by newer clients, kept verbatim.
	Extra map[string]json.RawMessage
}

// Entry represents a single password entry.
// Common keys stored in Metadata:
//   "password"  - the password
//   "url"       - the URL
//   "username"  - the username
//   "notes"     - free-form notes/description
// Any other keys are treated as custom metadata (e.g. "OTP Secret", "recovery_code").
// It's (un)marshaled by the methods in compat.go.
type Entry struct {
	// ID identifies the entry independently of its name (the map key), so it
	// survives renames. Assigned on save by EnsureIDs.
	ID        string
	Metadata  map[string]string
	CreatedAt time.Time
	UpdatedAt time.Time
	// Extra holds fields written by newer clients, kept verbatim so that
	// editing the entry here never drops them.
	Extra map[string]json.RawMessage
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
