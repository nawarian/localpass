/**
 * Load / save vault from encrypted byte data.
 *
 * Port of cli/internal/store/persist.go
 */

import { decrypt, encrypt } from "./crypto.js";
import type { Vault } from "./vault.js";
import { SUPPORTED_VAULT_VERSION, ensureIds, newVault } from "./vault.js";

/** Saving a vault newer than SUPPORTED_VAULT_VERSION was refused. */
export class VaultVersionError extends Error {
  constructor(public readonly version: number) {
    super(
      `This vault was saved by a newer LocalPass (format v${version}; this version supports v${SUPPORTED_VAULT_VERSION}). ` +
        "Update LocalPass to make changes.",
    );
    this.name = "VaultVersionError";
  }
}

/**
 * Decrypt and parse a vault from raw encrypted bytes.
 * If data is empty/undefined, returns a new empty vault.
 */
export async function loadStore(
  data: Uint8Array | undefined,
  primaryPassword: string
): Promise<Vault> {
  if (!data || data.length === 0) {
    return newVault();
  }

  const plaintext = await decrypt(data, primaryPassword);
  const text = new TextDecoder().decode(plaintext);
  const vault: Vault = JSON.parse(text);

  if (!vault.entries) {
    vault.entries = {};
  }

  return vault;
}

/**
 * Serialize, encrypt, and return a vault as encrypted bytes. Throws
 * VaultVersionError for a vault newer than SUPPORTED_VAULT_VERSION. Entries
 * without an ID get one, in place (see ensureIds), so the caller's copy
 * matches what was saved.
 */
export async function saveStore(
  vault: Vault,
  primaryPassword: string
): Promise<Uint8Array> {
  if (vault.version > SUPPORTED_VAULT_VERSION) throw new VaultVersionError(vault.version);
  ensureIds(vault);
  const json = JSON.stringify(vault);
  const plaintext = new TextEncoder().encode(json);
  return await encrypt(plaintext, primaryPassword);
}
