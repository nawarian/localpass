package store

import (
	"encoding/json"
	"fmt"
	"time"
)

// SupportedVersion is the newest vault format this build can write. A vault
// with a higher Version was written by a newer LocalPass: it can still be
// read, but saving it is refused so this build can't damage it.
const SupportedVersion = 1

// VersionError is returned when saving a vault newer than SupportedVersion.
type VersionError struct {
	Version int
}

func (e *VersionError) Error() string {
	return fmt.Sprintf("this vault uses format v%d, newer than this localpass supports (v%d); update localpass to make changes", e.Version, SupportedVersion)
}

// Fields newer clients add to the vault or to entries are kept verbatim in
// Extra, so reading and re-saving a vault never drops them.

type vaultFields struct {
	Version int              `json:"version"`
	Entries map[string]Entry `json:"entries"`
}

type entryFields struct {
	ID        string            `json:"id,omitempty"`
	Metadata  map[string]string `json:"metadata"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
}

// UnmarshalJSON decodes the known fields and keeps the rest in Extra.
func (v *Vault) UnmarshalJSON(data []byte) error {
	var known vaultFields
	if err := json.Unmarshal(data, &known); err != nil {
		return err
	}
	extra, err := unknownFields(data, "version", "entries")
	if err != nil {
		return err
	}
	*v = Vault{Version: known.Version, Entries: known.Entries, Extra: extra}
	return nil
}

// MarshalJSON encodes the known fields plus Extra.
func (v Vault) MarshalJSON() ([]byte, error) {
	return marshalWithExtra(vaultFields{Version: v.Version, Entries: v.Entries}, v.Extra)
}

// UnmarshalJSON decodes the known fields and keeps the rest in Extra.
func (e *Entry) UnmarshalJSON(data []byte) error {
	var known entryFields
	if err := json.Unmarshal(data, &known); err != nil {
		return err
	}
	extra, err := unknownFields(data, "id", "metadata", "created_at", "updated_at")
	if err != nil {
		return err
	}
	*e = Entry{ID: known.ID, Metadata: known.Metadata, CreatedAt: known.CreatedAt, UpdatedAt: known.UpdatedAt, Extra: extra}
	return nil
}

// MarshalJSON encodes the known fields plus Extra.
func (e Entry) MarshalJSON() ([]byte, error) {
	return marshalWithExtra(entryFields{ID: e.ID, Metadata: e.Metadata, CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt}, e.Extra)
}

// unknownFields returns the members of the JSON object data not named in known.
func unknownFields(data []byte, known ...string) (map[string]json.RawMessage, error) {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	for _, k := range known {
		delete(all, k)
	}
	if len(all) == 0 {
		return nil, nil
	}
	return all, nil
}

// marshalWithExtra encodes fields, adding extra's members when there are any
// (known fields win over an extra of the same name).
func marshalWithExtra(fields any, extra map[string]json.RawMessage) ([]byte, error) {
	data, err := json.Marshal(fields)
	if err != nil || len(extra) == 0 {
		return data, err
	}
	merged, err := unknownFields(data)
	if err != nil {
		return nil, err
	}
	out := make(map[string]json.RawMessage, len(extra)+len(merged))
	for k, v := range extra {
		out[k] = v
	}
	for k, v := range merged {
		out[k] = v
	}
	return json.Marshal(out)
}
