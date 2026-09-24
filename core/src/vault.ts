/**
 * Vault data model – port of cli/internal/store/store.go
 */

export interface Entry {
  /**
   * Identifies the entry independently of its name (the map key), so it
   * survives renames. Assigned on save by ensureIds; optional because vaults
   * saved by older clients don't have it.
   */
  id?: string;
  metadata: Record<string, string>;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  /** Fields written by newer clients; kept verbatim (see withPreservedFields). */
  [field: string]: unknown;
}

export interface Vault {
  version: number;
  entries: Record<string, Entry>;
  /** Fields written by newer clients; JSON round trips keep them. */
  [field: string]: unknown;
}

/**
 * The newest vault format this build can write. A vault with a higher
 * `version` was written by a newer LocalPass: it can still be read, but
 * saving it is refused so this build can't damage it.
 */
export const SUPPORTED_VAULT_VERSION = 1;

// Rebuilt from the edit form on every save. Everything else, `id` included,
// belongs to the entry itself and carries over.
const ENTRY_FIELDS = new Set(["metadata", "created_at", "updated_at"]);

/**
 * `next` plus every field of `prev` beyond metadata and timestamps — fields
 * a newer client stored on the entry. Use it whenever an edited entry is
 * rebuilt from scratch, so the edit doesn't drop them.
 */
export function withPreservedFields(prev: Entry | undefined, next: Entry): Entry {
  if (!prev) return next;
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(prev)) {
    if (!ENTRY_FIELDS.has(field)) kept[field] = value;
  }
  return { ...kept, ...next };
}

/**
 * Create a new empty vault with version 1.
 */
export function newVault(): Vault {
  return {
    version: 1,
    entries: {},
  };
}

/**
 * Add or update an entry for the given key.
 */
export function addEntry(vault: Vault, key: string, entry: Entry): void {
  vault.entries[key] = entry;
}

/**
 * Get an entry by key. Returns undefined if not found.
 */
export function getEntry(vault: Vault, key: string): Entry | undefined {
  return vault.entries[key];
}

/**
 * Delete an entry by key.
 */
export function deleteEntry(vault: Vault, key: string): void {
  delete vault.entries[key];
}

/**
 * Return all keys sorted alphabetically.
 */
export function listKeys(vault: Vault): string[] {
  return Object.keys(vault.entries).sort();
}

/**
 * Return keys that contain the query string (case-insensitive).
 */
export function search(vault: Vault, query: string): string[] {
  const q = query.toLowerCase();
  return Object.keys(vault.entries)
    .filter((k) => k.toLowerCase().includes(q))
    .sort();
}

/**
 * Standard metadata field names.
 */
export const STANDARD_FIELDS = new Set([
  "password",
  "url",
  "username",
  "notes",
  "otp",
]);

/**
 * Give every entry a stable unique ID, in place: entries without one (new, or
 * last saved by a client that predates IDs) get a fresh one, and if two
 * entries share an ID, all but the first by name get a fresh one. Existing
 * unique IDs never change, so an entry keeps its ID across renames.
 */
export function ensureIds(vault: Vault): void {
  const seen = new Set<string>();
  for (const key of Object.keys(vault.entries).sort()) {
    const entry = vault.entries[key];
    if (typeof entry.id === "string" && entry.id && !seen.has(entry.id)) {
      seen.add(entry.id);
      continue;
    }
    entry.id = crypto.randomUUID();
    seen.add(entry.id);
  }
}
