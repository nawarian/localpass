/**
 * Load / save vault from encrypted byte data.
 *
 * Port of cli/internal/store/persist.go
 */

import { decrypt, encrypt } from "./crypto.js";
import type { Vault } from "./vault.js";
import { newVault } from "./vault.js";

/**
 * Decrypt and parse a vault from raw encrypted bytes.
 * If data is empty/undefined, returns a new empty vault.
 */
export async function loadStore(
  data: Uint8Array | undefined,
  masterPassword: string
): Promise<Vault> {
  if (!data || data.length === 0) {
    return newVault();
  }

  const plaintext = await decrypt(data, masterPassword);
  const text = new TextDecoder().decode(plaintext);
  const vault: Vault = JSON.parse(text);

  if (!vault.entries) {
    vault.entries = {};
  }

  return vault;
}

/**
 * Serialize, encrypt, and return a vault as encrypted bytes.
 */
export async function saveStore(
  vault: Vault,
  masterPassword: string
): Promise<Uint8Array> {
  const json = JSON.stringify(vault);
  const plaintext = new TextEncoder().encode(json);
  return await encrypt(plaintext, masterPassword);
}
