package store

import (
	"crypto/rand"
	"fmt"
	"sort"
)

// EnsureIDs gives every entry a stable unique ID: entries without one (new,
// or last saved by a client that predates IDs) get a fresh one, and if two
// entries share an ID, all but the first by name get a fresh one. Existing
// unique IDs are never changed, so an entry keeps its ID across renames.
func (v *Vault) EnsureIDs() {
	keys := make([]string, 0, len(v.Entries))
	for k := range v.Entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	seen := make(map[string]bool, len(keys))
	for _, k := range keys {
		e := v.Entries[k]
		if e.ID != "" && !seen[e.ID] {
			seen[e.ID] = true
			continue
		}
		e.ID = NewID()
		seen[e.ID] = true
		v.Entries[k] = e
	}
}

// NewID returns a random (version 4) UUID.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
