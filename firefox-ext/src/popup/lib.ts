/**
 * LocalPass Popup — non-UI logic.
 *
 * Decryption happens in the popup (a stable page); the background only stores
 * config + encrypted bytes — service-worker memory isn't reliable. Everything
 * here is framework-agnostic so the Preact components stay declarative.
 */

import type { Config, Entry, Vault } from "@localpass/core";
import { s3Download, s3Upload } from "@localpass/core/dist/s3.js";
import { loadStore, saveStore } from "@localpass/core/dist/store.js";

export type UIState = "no_config" | "no_vault" | "locked" | "unlocked";

export interface Settings {
  autoLockMinutes: number;
}

const SETTINGS_KEY = "localpass:settings";
const SESSION_VAULT_KEY = "localpass:cached_vault";
const DEFAULT_AUTO_LOCK_MIN = 5;
const SITES_PROMPTED_KEY = "localpass:sites_prompted";

// ---------- settings & session cache ----------

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  const min = stored?.autoLockMinutes;
  return {
    autoLockMinutes: typeof min === "number" && min > 0 ? min : DEFAULT_AUTO_LOCK_MIN,
  };
}

interface CachedVault {
  vault: Vault;
  primaryPassword: string;
  expiresAt: number;
}

export async function loadCachedVault(): Promise<{ vault: Vault; primaryPassword: string } | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as CachedVault | undefined;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    return null;
  }
  // Older cache shape had no primaryPassword (or used the legacy field name). Treat as locked.
  if (typeof cached.primaryPassword !== "string" || !cached.primaryPassword) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    return null;
  }
  return { vault: cached.vault, primaryPassword: cached.primaryPassword };
}

export async function saveCachedVault(v: Vault, password: string): Promise<void> {
  const settings = await getSettings();
  const expiresAt = Date.now() + settings.autoLockMinutes * 60_000;
  const payload: CachedVault = { vault: v, primaryPassword: password, expiresAt };
  await browser.storage.session.set({ [SESSION_VAULT_KEY]: payload });
}

export async function clearCachedVault(): Promise<void> {
  await browser.storage.session.remove(SESSION_VAULT_KEY);
}

/**
 * Prompt for `<all_urls>` host permission once after the user has unlocked.
 * Without this, the in-page autofill dropdown can't appear on sites the user
 * hasn't manually approved. We respect the user's decision: if they accept
 * or dismiss, we never ask again — they can flip it later from Settings.
 */
export async function maybeRequestSitesPermission(): Promise<void> {
  if (!browser.permissions) return;
  try {
    const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
    if (granted) return;
    const stored = await browser.storage.local.get(SITES_PROMPTED_KEY);
    if (stored[SITES_PROMPTED_KEY]) return;
    try {
      await browser.permissions.request({ origins: ["<all_urls>"] });
    } catch {
      /* user dismissed, or gesture window lost — fine */
    }
    await browser.storage.local.set({ [SITES_PROMPTED_KEY]: true });
  } catch {
    /* permissions API unavailable in this Firefox — silently skip */
  }
}

// ---------- visual helpers ----------

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function colorFor(name: string): string {
  const palette = [
    "bg-indigo-500",
    "bg-emerald-500",
    "bg-rose-500",
    "bg-amber-500",
    "bg-sky-500",
    "bg-fuchsia-500",
    "bg-teal-500",
    "bg-orange-500",
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

export function ensureHttp(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

// ---------- messaging ----------

export async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return (await browser.runtime.sendMessage({ type, payload })) as T;
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

// Wait until the browser has actually painted. Argon2id key derivation is a
// synchronous CPU burst that freezes the main thread for ~1–2s; without this,
// a state update that shows the sync banner never makes it to screen before
// the freeze starts. Two rAFs ≈ "after the next paint completes".
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// ---------- edit draft ----------

export interface CustomField {
  id: number;
  name: string;
  value: string;
}

export interface EditDraft {
  originalKey: string | null; // null for a new entry
  key: string;
  username: string;
  password: string;
  website: string;
  notes: string;
  custom: CustomField[];
  createdAt: string | null;
}

let nextCustomId = 1;
export function allocCustomId(): number {
  return nextCustomId++;
}

export function entryToDraft(key: string, entry: Entry): EditDraft {
  const meta = { ...(entry.metadata || {}) };
  const username = meta["username"] ?? meta["email"] ?? "";
  const password = meta["password"] ?? "";
  const website = meta["url"] ?? meta["website"] ?? "";
  const notes = meta["notes"] ?? "";
  const standard = new Set(["username", "email", "password", "url", "website", "notes"]);
  const custom = Object.entries(meta)
    .filter(([k]) => !standard.has(k))
    .map(([name, value]) => ({ id: allocCustomId(), name, value }));
  return {
    originalKey: key,
    key,
    username,
    password,
    website,
    notes,
    custom,
    createdAt: entry.created_at,
  };
}

export function newDraft(): EditDraft {
  return {
    originalKey: null,
    key: "",
    username: "",
    password: "",
    website: "",
    notes: "",
    custom: [],
    createdAt: null,
  };
}

export function draftToEntry(draft: EditDraft, prevCreatedAt: string | null): Entry {
  const metadata: Record<string, string> = {};
  if (draft.username) metadata["username"] = draft.username;
  if (draft.password) metadata["password"] = draft.password;
  if (draft.website) metadata["url"] = draft.website;
  if (draft.notes) metadata["notes"] = draft.notes;
  for (const f of draft.custom) {
    const name = f.name.trim();
    if (!name) continue;
    metadata[name] = f.value;
  }
  const now = new Date().toISOString();
  return {
    metadata,
    created_at: prevCreatedAt ?? now,
    updated_at: now,
  };
}

// ---------- bootstrap state ----------

export async function determineInitialState(): Promise<UIState> {
  const cfg = await send<Config | null>("CONFIG_GET");
  if (!cfg || !cfg.s3_bucket) return "no_config";
  const b64 = await send<string | null>("VAULT_BYTES_GET");
  if (!b64) return "no_vault";
  return "locked";
}

// ---------- persist / push / pull ----------

type Result = { ok: true } | { ok: false; error: string };

export async function persistVault(
  vault: Vault,
  primaryPassword: string,
): Promise<Result> {
  try {
    const bytes = await saveStore(vault, primaryPassword);
    await send("VAULT_BYTES_SET", { b64: bytesToBase64(bytes), keepSession: true });
    await saveCachedVault(vault, primaryPassword);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function pushToS3(): Promise<Result> {
  const cfg = await send<Config | null>("CONFIG_GET");
  if (!cfg) return { ok: false, error: "No config saved." };
  if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
    return { ok: false, error: "Incomplete S3 configuration." };
  }
  const b64 = await send<string | null>("VAULT_BYTES_GET");
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
  const cfg = await send<Config | null>("CONFIG_GET");
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
    await send("VAULT_BYTES_SET", { b64: bytesToBase64(data) });
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
  const b64 = await send<string | null>("VAULT_BYTES_GET");
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
