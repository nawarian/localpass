/**
 * Sign-up password generation: pending credentials + save on submit.
 *
 * When the user accepts a generated password on a sign-up form, the content
 * script records it here as a pending credential. On form submit it asks us to
 * commit it: we pull the latest vault from S3, add the entry, persist and push
 * — the same pipeline (and the same write lock) the popup uses for its saves.
 * Anything never committed stays pending so the popup can offer to save it.
 */

import type { Vault } from "@localpass/core";
import { addEntry } from "@localpass/core/dist/vault.js";
import {
  PENDING_CREDENTIALS_KEY,
  SESSION_VAULT_KEY,
  clearPendingCredentials,
  loadPendingCredentials,
  persistVault,
  pullAndDecrypt,
  pushToS3,
  withVaultLock,
  type CachedVault,
  type PendingCredential,
  type SaveCredentialResult,
} from "../shared/vault-store";

export type { SaveCredentialResult };

/** A submit that had nothing to save: no generated password was accepted. */
export type SubmitResult = SaveCredentialResult | { ok: false; skipped: true };

/** The unlocked session (vault + primary password), or null when locked. */
async function readSession(): Promise<CachedVault | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as CachedVault | undefined;
  if (!cached || !cached.primaryPassword) return null;
  if (Date.now() >= cached.expiresAt) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    await clearPendingCredentials();
    return null;
  }
  return cached;
}

export async function isUnlocked(): Promise<boolean> {
  return (await readSession()) !== null;
}

/** http(s) origin of a page URL, or null for anything else. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ---------- pending credentials ----------

export async function setPending(origin: string, username: string, password: string): Promise<void> {
  const all = await loadPendingCredentials();
  all[origin] = { origin, username, password, createdAt: Date.now() };
  await browser.storage.session.set({ [PENDING_CREDENTIALS_KEY]: all });
}

export async function getPending(origin: string): Promise<PendingCredential | null> {
  return (await loadPendingCredentials())[origin] ?? null;
}

export async function discardPending(origin: string): Promise<void> {
  const all = await loadPendingCredentials();
  if (!(origin in all)) return;
  delete all[origin];
  await browser.storage.session.set({ [PENDING_CREDENTIALS_KEY]: all });
}

/** Pending credentials for the popup banner — without the passwords. */
export async function listPending(): Promise<{ origin: string; username: string; createdAt: number }[]> {
  if (!(await isUnlocked())) return [];
  return Object.values(await loadPendingCredentials())
    .map(({ origin, username, createdAt }) => ({ origin, username, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- save ----------

/**
 * Pick a vault key for a new credential without overwriting anything:
 * `example.com`, then `example.com (alice)`, then `example.com (alice) 2`, …
 */
export function uniqueEntryKey(vault: Vault, origin: string, username: string): string {
  const base = new URL(origin).hostname.replace(/^www\./, "");
  if (!vault.entries[base]) return base;
  const named = username ? `${base} (${username})` : base;
  if (!vault.entries[named]) return named;
  for (let n = 2; ; n++) {
    const candidate = `${named} ${n}`;
    if (!vault.entries[candidate]) return candidate;
  }
}

/**
 * Commit the pending credential for `origin` as a new vault entry and sync it.
 * `values` overrides the stored username/password (a submit reads them from
 * the page, so a password the user tweaked after accepting is saved as
 * edited). The pending check runs inside the write lock, so a double submit
 * can't save the same credential twice.
 *
 * The local persist is what counts as "saved": a failed push is reported but
 * the entry is kept, matching the popup's "S3 sync failed" state. On any
 * earlier failure the pending credential stays so the popup can retry.
 */
async function commitPending(
  origin: string,
  values?: { username: string; password: string },
): Promise<SubmitResult> {
  return withVaultLock(async (): Promise<SubmitResult> => {
    const pending = await getPending(origin);
    // Only passwords the user explicitly accepted from the generator get saved.
    if (!pending) return { ok: false, skipped: true };
    const { username, password } = values ?? pending;
    if (!password) {
      // The user cleared the field, so they're not using the generated password.
      await discardPending(origin);
      return { ok: false, skipped: true };
    }

    const session = await readSession();
    if (!session) return { ok: false, error: "Vault is locked." };

    const refreshed = await pullAndDecrypt(session.primaryPassword);
    if (!refreshed.ok) return { ok: false, error: `Refresh failed: ${refreshed.error}` };
    const v = refreshed.vault;

    const key = uniqueEntryKey(v, origin, username);
    const now = new Date().toISOString();
    const metadata: Record<string, string> = { password, url: origin };
    if (username) metadata["username"] = username;
    addEntry(v, key, { metadata, created_at: now, updated_at: now });

    const persistRes = await persistVault(v, session.primaryPassword);
    if (!persistRes.ok) return { ok: false, error: persistRes.error };
    await discardPending(origin);

    const pushRes = await pushToS3();
    if (!pushRes.ok) return { ok: true, key, synced: false, error: `S3 sync failed: ${pushRes.error}` };
    return { ok: true, key, synced: true };
  });
}

/** Commit from a sign-up form submit, with the values the page holds now. */
export function saveFromSubmit(origin: string, username: string, password: string): Promise<SubmitResult> {
  return commitPending(origin, { username, password });
}

/** Commit from the popup's "Save" button, with the values stored on accept. */
export async function savePending(origin: string): Promise<SaveCredentialResult> {
  const res = await commitPending(origin);
  return "skipped" in res ? { ok: false, error: "Nothing to save." } : res;
}
