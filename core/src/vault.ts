/**
 * Vault data model – port of cli/internal/store/store.go
 */

export interface Entry {
  metadata: Record<string, string>;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

export interface Vault {
  version: number;
  entries: Record<string, Entry>;
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
]);
