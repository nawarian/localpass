/**
 * Vault persistence + S3 sync shared by the popup and the background.
 *
 * Talks to extension storage directly rather than via runtime messages, so the
 * background can use it too (it can't message its own listener). Every write
 * path (popup save/delete, background sign-up save) runs the same pull →
 * merge → persist → push sequence under `withVaultLock`, so two contexts can't
 * interleave and one clobber the other's change.
 */

import type { Config, Vault } from "@localpass/core";
import { s3Download, s3Upload } from "@localpass/core/dist/s3.js";
import { loadStore, saveStore } from "@localpass/core/dist/store.js";

export const CONFIG_KEY = "localpass:config";
export const VAULT_KEY = "localpass:vault";
export const SESSION_VAULT_KEY = "localpass:cached_vault";
export const SETTINGS_KEY = "localpass:settings";
const DEFAULT_AUTO_LOCK_MIN = 5;
const VAULT_LOCK_NAME = "localpass:vault-write";

export interface Settings {
  autoLockMinutes: number;
}

export interface CachedVault {
  vault: Vault;
  primaryPassword: string;
  expiresAt: number;
}

export type Result = { ok: true } | { ok: false; error: string };

// ---------- settings & storage ----------

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  const min = stored?.autoLockMinutes;
  return {
    autoLockMinutes: typeof min === "number" && min > 0 ? min : DEFAULT_AUTO_LOCK_MIN,
  };
}

export async function loadConfig(): Promise<Config | null> {
  const result = await browser.storage.local.get(CONFIG_KEY);
  return (result[CONFIG_KEY] as Config) ?? null;
}

export async function getVaultBytesB64(): Promise<string | null> {
  const result = await browser.storage.local.get(VAULT_KEY);
  return (result[VAULT_KEY] as string | undefined) ?? null;
}

export async function setVaultBytesB64(b64: string, keepSession = false): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: b64 });
  if (!keepSession) {
    // New bytes may have been encrypted with a different password, so the
    // previously cached unlocked vault is no longer valid. Force re-unlock.
    await browser.storage.session.remove(SESSION_VAULT_KEY);
  }
}

export async function saveCachedVault(v: Vault, password: string): Promise<void> {
  const settings = await getSettings();
  const expiresAt = Date.now() + settings.autoLockMinutes * 60_000;
  const payload: CachedVault = { vault: v, primaryPassword: password, expiresAt };
  await browser.storage.session.set({ [SESSION_VAULT_KEY]: payload });
}

export function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- cross-context write lock ----------

/**
 * Run `fn` while holding the vault write lock. Web Locks are shared by every
 * extension context of the same origin (popup, background, options), so a
 * popup save and a background sign-up save are serialized end to end.
 */
export async function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return fn();
  return navigator.locks.request(VAULT_LOCK_NAME, fn) as Promise<T>;
}

// ---------- persist / push / pull ----------

export async function persistVault(vault: Vault, primaryPassword: string): Promise<Result> {
  try {
    const bytes = await saveStore(vault, primaryPassword);
    await setVaultBytesB64(bytesToBase64(bytes), true);
    await saveCachedVault(vault, primaryPassword);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function pushToS3(): Promise<Result> {
  const cfg = await loadConfig();
  if (!cfg) return { ok: false, error: "No config saved." };
  if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
    return { ok: false, error: "Incomplete S3 configuration." };
  }
  const b64 = await getVaultBytesB64();
  if (!b64) return { ok: false, error: "No vault data to push." };
  try {
    await s3Upload(
      {
        endpoint: cfg.s3_endpoint || undefined,
        region: cfg.s3_region || "us-east-1",
        bucket: cfg.s3_bucket,
        key: cfg.s3_key,
        accessKeyId: cfg.aws_access_key_id,
        secretAccessKey: cfg.aws_secret_access_key,
      },
      base64ToBytes(b64),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function pullFromS3(): Promise<Result> {
  const cfg = await loadConfig();
  if (!cfg) return { ok: false, error: "No config saved." };
  if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
    return { ok: false, error: "Incomplete S3 configuration." };
  }
  try {
    const data = await s3Download({
      endpoint: cfg.s3_endpoint || undefined,
      region: cfg.s3_region || "us-east-1",
      bucket: cfg.s3_bucket,
      key: cfg.s3_key,
      accessKeyId: cfg.aws_access_key_id,
      secretAccessKey: cfg.aws_secret_access_key,
    });
    await setVaultBytesB64(bytesToBase64(data));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function pullAndDecrypt(
  primaryPassword: string | null,
): Promise<{ ok: true; vault: Vault } | { ok: false; error: string }> {
  if (!primaryPassword) return { ok: false, error: "Vault is locked." };
  const pullRes = await pullFromS3();
  if (!pullRes.ok) return { ok: false, error: pullRes.error };
  const b64 = await getVaultBytesB64();
  if (!b64) return { ok: false, error: "No vault data after refresh." };
  try {
    const fresh = await loadStore(base64ToBytes(b64), primaryPassword);
    await saveCachedVault(fresh, primaryPassword);
    return { ok: true, vault: fresh };
  } catch (err) {
    const msg = (err as Error).message;
    if (/wrong primary password|WRONG_PASSWORD/i.test(msg)) {
      return {
        ok: false,
        error: "Cached password no longer matches the vault on S3. Lock and unlock again.",
      };
    }
    return { ok: false, error: msg };
  }
}

// ---------- pending generated credentials ----------
//
// A password the user accepted from the in-page generator but hasn't saved to
// the vault yet (the sign-up form wasn't submitted, or submit detection missed
// it). Keyed by origin, kept in in-memory session storage only (never
// storage.local), and dropped whenever the vault locks.

export const PENDING_CREDENTIALS_KEY = "localpass:pending_credentials";

export interface PendingCredential {
  origin: string;
  username: string;
  password: string;
  createdAt: number;
}

export type PendingCredentials = Record<string, PendingCredential>;

/** Outcome of saving a generated credential; `synced: false` means saved locally only. */
export type SaveCredentialResult =
  | { ok: true; key: string; synced: true }
  | { ok: true; key: string; synced: false; error: string }
  | { ok: false; error: string };

export async function loadPendingCredentials(): Promise<PendingCredentials> {
  const result = await browser.storage.session.get(PENDING_CREDENTIALS_KEY);
  return (result[PENDING_CREDENTIALS_KEY] as PendingCredentials | undefined) ?? {};
}

export async function clearPendingCredentials(): Promise<void> {
  await browser.storage.session.remove(PENDING_CREDENTIALS_KEY);
}
