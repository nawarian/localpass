/**
 * LocalPass Popup — non-UI logic.
 *
 * Decryption happens in the popup (a stable page); the background keeps no
 * decrypted state of its own — service-worker memory isn't reliable. Vault
 * persistence + S3 sync live in ../shared/vault-store (shared with the
 * background's sign-up saves) and are re-exported here. Everything here is
 * framework-agnostic so the Preact components stay declarative.
 */

import type { Config, Entry, Vault } from "@localpass/core";
import { addEntry, deleteEntry } from "@localpass/core/dist/vault.js";
import { SESSION_VAULT_KEY, clearPendingCredentials, type CachedVault } from "../shared/vault-store";

export {
  base64ToBytes,
  bytesToBase64,
  getSettings,
  persistVault,
  pullAndDecrypt,
  pullFromS3,
  pushToS3,
  saveCachedVault,
  withVaultLock,
  type Settings,
} from "../shared/vault-store";

export type UIState = "no_config" | "no_vault" | "locked" | "unlocked";

const POPUP_UI_KEY = "localpass:popup_ui";
const SITES_PROMPTED_KEY = "localpass:sites_prompted";

// ---------- settings & session cache ----------

export async function loadCachedVault(): Promise<{ vault: Vault; primaryPassword: string } | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as CachedVault | undefined;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    // Auto-lock expired: drop the cached vault and any transient UI snapshot
    // (which may hold a half-typed draft/password) together.
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    await clearPopupUI();
    await clearPendingCredentials();
    return null;
  }
  // Older cache shape had no primaryPassword (or used the legacy field name). Treat as locked.
  if (typeof cached.primaryPassword !== "string" || !cached.primaryPassword) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    await clearPopupUI();
    await clearPendingCredentials();
    return null;
  }
  return { vault: cached.vault, primaryPassword: cached.primaryPassword };
}

export async function clearCachedVault(): Promise<void> {
  await browser.storage.session.remove(SESSION_VAULT_KEY);
  // Locking / clearing the vault must also drop any transient UI snapshot and
  // unsaved generated passwords, so a leftover draft or password can't
  // resurface on reopen.
  await clearPopupUI();
  await clearPendingCredentials();
}

// ---------- transient popup UI snapshot ----------
//
// Firefox tears the popup down whenever it loses focus (alt+tab, clicking
// another window), discarding all component state. We snapshot the transient,
// data-only UI state into in-memory session storage (same place the decrypted
// vault + primary password already live) so reopening restores it as if the
// popup was never dismissed. Never persisted to disk (storage.local).

export interface PopupUISnapshot {
  searchQuery: string;
  selectedKey: string | null;
  editDraft: EditDraft | null;
  nextCustomId: number;
  // Primary (unlock) password being typed on the locked screen, pre-auth.
  lockedPassword: string;
}

export async function loadPopupUI(): Promise<PopupUISnapshot | null> {
  const result = await browser.storage.session.get(POPUP_UI_KEY);
  const snap = result[POPUP_UI_KEY] as PopupUISnapshot | undefined;
  return snap ?? null;
}

export async function savePopupUI(snapshot: PopupUISnapshot): Promise<void> {
  await browser.storage.session.set({ [POPUP_UI_KEY]: snapshot });
}

export async function clearPopupUI(): Promise<void> {
  await browser.storage.session.remove(POPUP_UI_KEY);
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

// Sliding auto-lock: tell the background to push the idle timer forward on a
// genuine user interaction. Throttled so a burst of keystrokes/clicks only
// sends one message every few seconds — bumping expiresAt is cheap but we
// don't need to spam the service worker (and a touch never resurrects an
// already-expired vault, so the worst case is harmless).
const TOUCH_THROTTLE_MS = 3_000;
let lastTouchAt = 0;

export function touchVault(): void {
  const now = Date.now();
  if (now - lastTouchAt < TOUCH_THROTTLE_MS) return;
  lastTouchAt = now;
  void send("VAULT_TOUCH").catch(() => {
    /* background unavailable — expiry just won't extend this once */
  });
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

// Metadata keys with dedicated UI; everything else is a custom field.
// `email` / `website` are legacy aliases of `username` / `url`.
export const STANDARD_KEYS = new Set(["username", "email", "password", "url", "website", "notes", "otp"]);

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
  // Raw OTP input: a canonical otpauth:// URI when loaded from an entry, or
  // whatever the user typed (URI or bare Base32 secret) until saved.
  otp: string;
  custom: CustomField[];
  createdAt: string | null;
}

let nextCustomId = 1;
export function allocCustomId(): number {
  return nextCustomId++;
}

// Restoring a draft from a snapshot must also restore/advance the module-level
// counter so freshly added custom fields don't collide with the restored ones.
export function ensureNextCustomId(min: number): void {
  if (Number.isFinite(min) && min > nextCustomId) nextCustomId = min;
}

export function entryToDraft(key: string, entry: Entry): EditDraft {
  const meta = { ...(entry.metadata || {}) };
  const username = meta["username"] ?? meta["email"] ?? "";
  const password = meta["password"] ?? "";
  const website = meta["url"] ?? meta["website"] ?? "";
  const notes = meta["notes"] ?? "";
  const otp = meta["otp"] ?? "";
  const custom = Object.entries(meta)
    .filter(([k]) => !STANDARD_KEYS.has(k))
    .map(([name, value]) => ({ id: allocCustomId(), name, value }));
  return {
    originalKey: key,
    key,
    username,
    password,
    website,
    notes,
    otp,
    custom,
    createdAt: entry.created_at,
  };
}

/**
 * A "New item" draft prefilled from an existing entry, for a second account
 * that shares most of its details. The OTP is left empty: a TOTP secret
 * belongs to exactly one account, and a copied one produces codes the other
 * account rejects.
 */
export function duplicateDraft(key: string, entry: Entry, entries: Record<string, unknown>): EditDraft {
  return {
    ...entryToDraft(key, entry),
    originalKey: null,
    key: copyName(key, entries),
    otp: "",
    createdAt: null,
  };
}

/** `name (copy)`, then `name (copy 2)`, … — the first one not taken. */
function copyName(key: string, entries: Record<string, unknown>): string {
  const base = `${key} (copy)`;
  if (!(base in entries)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${key} (copy ${n})`;
    if (!(candidate in entries)) return candidate;
  }
}

/**
 * What saving a draft does: add a new entry, update the entry in place, or
 * rename it — which removes the entry under its old name.
 */
export type SaveKind = "new" | "update" | "rename";

export function saveKind(draft: EditDraft): SaveKind {
  if (draft.originalKey === null) return "new";
  return draft.originalKey === draft.key.trim() ? "update" : "rename";
}

/** The confirmation shown before a rename, which drops the old name. */
export function renameConfirmMessage(draft: EditDraft): string {
  return (
    `Rename "${draft.originalKey}" to "${draft.key.trim()}"?\n\n` +
    `"${draft.originalKey}" will no longer exist. To keep it and add a new ` +
    `item, cancel and use Duplicate instead.`
  );
}

/**
 * Apply a saved draft to the (freshly pulled) vault as `entry`. Returns an
 * error message when the target name is already taken, otherwise null.
 */
export function applyDraft(vault: Vault, draft: EditDraft, entry: Entry): string | null {
  const key = draft.key.trim();
  const kind = saveKind(draft);
  if (kind !== "update" && vault.entries[key]) return `Item "${key}" already exists`;
  if (kind === "rename" && draft.originalKey !== null) deleteEntry(vault, draft.originalKey);
  addEntry(vault, key, entry);
  return null;
}

export function newDraft(): EditDraft {
  return {
    originalKey: null,
    key: "",
    username: "",
    password: "",
    website: "",
    notes: "",
    otp: "",
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
  if (draft.otp) metadata["otp"] = draft.otp;
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

