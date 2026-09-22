/**
 * LocalPass Background Script
 *
 * Stores config and encrypted vault bytes. The decrypted vault is cached in
 * browser.storage.session (in-memory, owned by the popup). Background reads
 * it to serve autofill requests from content scripts, and saves passwords
 * generated on sign-up forms (see ./signup.ts).
 */

import type { Config, Vault } from "@localpass/core";
import { generatePassword } from "@localpass/core/dist/generator.js";
import { generateTotp } from "@localpass/core/dist/otp.js";
import {
  CONFIG_KEY,
  SESSION_VAULT_KEY,
  VAULT_KEY,
  clearPendingCredentials,
  getSettings,
  getVaultBytesB64,
  loadConfig,
  setVaultBytesB64,
} from "../shared/vault-store";
import {
  discardPending,
  isUnlocked,
  listPending,
  originOf,
  saveFromSubmit,
  savePending,
  setPending,
  type SaveCredentialResult,
} from "./signup";

async function saveConfig(config: Config): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

async function readCachedVault(): Promise<Vault | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as { vault: Vault; expiresAt: number } | undefined;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    await clearPendingCredentials();
    return null;
  }
  return cached.vault;
}

/**
 * Sliding-expiry bump: on a genuine user interaction, push `expiresAt` forward
 * so an actively-used vault doesn't lock mid-task. Never resurrects an
 * already-expired vault (lazy expiry has likely cleared it, but we guard
 * anyway) and never touches the password/vault fields — expiry-only rewrite,
 * so every other field is preserved verbatim.
 */
async function touchCachedVault(): Promise<void> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as
    | { vault: Vault; primaryPassword?: string; expiresAt: number }
    | undefined;
  if (!cached) return;
  if (Date.now() >= cached.expiresAt) return; // don't revive an expired vault
  const minutes = (await getSettings()).autoLockMinutes;
  const expiresAt = Date.now() + minutes * 60_000;
  await browser.storage.session.set({
    [SESSION_VAULT_KEY]: { ...cached, expiresAt },
  });
}

function hostnameOf(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameMatches(entryHost: string, pageHost: string): boolean {
  if (entryHost === pageHost) return true;
  // subdomain match in either direction
  if (pageHost.endsWith(`.${entryHost}`)) return true;
  if (entryHost.endsWith(`.${pageHost}`)) return true;
  return false;
}

/**
 * Match a user-supplied pattern from the `match` metadata field against the
 * current page hostname.
 *
 *   "*.foo.com"      → any subdomain of foo.com (including foo.com itself)
 *   "foo.com"        → foo.com or any subdomain (same rule as url field)
 *   "https://x.com"  → hostname of the URL is extracted, then same as above
 */
function matchesPattern(pattern: string, pageHost: string): boolean {
  let p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return pageHost === base || pageHost.endsWith(`.${base}`);
  }
  if (/^https?:\/\//.test(p)) {
    const h = hostnameOf(p);
    if (!h) return false;
    p = h;
  }
  return pageHost === p || pageHost.endsWith(`.${p}`);
}

type AutofillEntry = { key: string; username: string; hasOtp: boolean };

type AutofillQueryResult =
  | { state: "no_vault" }
  | { state: "locked" }
  | { state: "unlocked"; matches: AutofillEntry[]; others: AutofillEntry[] };

async function autofillQuery(pageUrl: string, interactive = false): Promise<AutofillQueryResult> {
  // Fast path: if a session vault is cached, skip the local-storage bytes
  // check entirely — saves one round-trip on the common (unlocked) case.
  const vault = await readCachedVault();
  if (!vault) {
    const bytes = await getVaultBytesB64();
    if (!bytes) return { state: "no_vault" };
    return { state: "locked" };
  }

  // Only an explicit user action (opening the dropdown) extends the timer; the
  // automatic page-load prime query passes interactive=false and must not.
  if (interactive) await touchCachedVault();

  const pageHost = hostnameOf(pageUrl);
  const matches: AutofillEntry[] = [];
  const others: AutofillEntry[] = [];

  for (const [key, entry] of Object.entries(vault.entries)) {
    const meta = entry.metadata || {};
    const username = meta["username"] || meta["email"] || "";
    const summary: AutofillEntry = { key, username, hasOtp: !!meta["otp"] };

    let matched = false;
    if (pageHost) {
      const candidates = [meta["url"], meta["website"]].filter(Boolean) as string[];
      for (const c of candidates) {
        const h = hostnameOf(c);
        if (h && hostnameMatches(h, pageHost)) {
          matched = true;
          break;
        }
      }
      // explicit `match` metadata: comma/newline/whitespace-separated patterns
      if (!matched && meta["match"]) {
        const patterns = meta["match"].split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        for (const p of patterns) {
          if (matchesPattern(p, pageHost)) {
            matched = true;
            break;
          }
        }
      }
      // also match if entry key is or contains the page host's registrable label
      if (!matched) {
        const lowerKey = key.toLowerCase();
        const label = pageHost.split(".").slice(-2, -1)[0] || pageHost;
        if (lowerKey === pageHost || lowerKey === label || lowerKey.includes(label)) {
          matched = true;
        }
      }
    }

    if (matched) matches.push(summary);
    else others.push(summary);
  }

  matches.sort((a, b) => a.key.localeCompare(b.key));
  others.sort((a, b) => a.key.localeCompare(b.key));
  return { state: "unlocked", matches, others };
}

async function autofillFill(key: string): Promise<{ ok: false } | { ok: true; username: string; password: string }> {
  const vault = await readCachedVault();
  if (!vault) return { ok: false };
  const entry = vault.entries[key];
  if (!entry) return { ok: false };
  // Filling an entry is an explicit user action — extend the idle timer.
  await touchCachedVault();
  const meta = entry.metadata || {};
  return {
    ok: true,
    username: meta["username"] || meta["email"] || "",
    password: meta["password"] || "",
  };
}

/**
 * Compute the TOTP code for an entry at request time, so the code filled into
 * the page is the one valid at the moment the user clicked.
 */
async function autofillOtp(key: string): Promise<{ ok: false } | { ok: true; code: string }> {
  const vault = await readCachedVault();
  if (!vault) return { ok: false };
  const otp = vault.entries[key]?.metadata?.["otp"];
  if (!otp) return { ok: false };
  await touchCachedVault();
  try {
    const { code } = await generateTotp(otp);
    return { ok: true, code };
  } catch {
    return { ok: false };
  }
}

/**
 * Tell the tab how a sign-up save went. Sent as a fresh message rather than a
 * reply, because a form submit usually navigates away and the new page's
 * content script is the one still around to show it.
 */
function notifySaveResult(tabId: number | undefined, res: SaveCredentialResult): void {
  if (tabId === undefined) return;
  const toast = !res.ok
    ? { kind: "error", text: `Couldn't save password: ${res.error}` }
    : res.synced
    ? { kind: "success", text: `Saved to LocalPass as "${res.key}"` }
    : { kind: "error", text: `Saved as "${res.key}", but ${res.error}` };
  browser.tabs.sendMessage(tabId, { type: "LOCALPASS_TOAST", ...toast }).catch(() => {});
}

async function broadcastVaultUpdate(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      browser.tabs
        .sendMessage(tab.id, { type: "VAULT_STATE_PUSH" })
        .catch(() => {
          /* tabs without our content script (privileged URLs, etc.) — ignore */
        });
    }
  } catch {
    /* no tabs permission to enumerate — nothing to broadcast to */
  }
}

/**
 * Decide whether a session-cache change is meaningful enough to broadcast.
 *
 * A sliding-expiry touch rewrites only `expiresAt`. Broadcasting on that would
 * make content scripts re-run AUTOFILL_QUERY → touch again → re-broadcast, an
 * infinite loop. So we broadcast only when the *meaningful* state changes:
 *   - the vault appears or disappears (lock ↔ unlock), or
 *   - its entries change.
 * If both old and new exist and differ ONLY in `expiresAt`, we skip.
 */
function sessionChangeIsMeaningful(
  oldValue: { vault?: Vault } | undefined,
  newValue: { vault?: Vault } | undefined,
): boolean {
  // Appeared or disappeared → lock/unlock transition.
  if (!oldValue || !newValue) return true;
  // Both present: compare entries (the only user-visible vault state the
  // content script renders). A pure expiry bump leaves these identical.
  return JSON.stringify(oldValue.vault?.entries) !== JSON.stringify(newValue.vault?.entries);
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && SESSION_VAULT_KEY in changes) {
    const { oldValue, newValue } = changes[SESSION_VAULT_KEY];
    if (sessionChangeIsMeaningful(oldValue, newValue)) {
      void broadcastVaultUpdate();
    }
  } else if (areaName === "local" && VAULT_KEY in changes) {
    void broadcastVaultUpdate();
  }
});

browser.runtime.onMessage.addListener((message: unknown, sender: browser.runtime.MessageSender) => {
  const msg = message as { type: string; payload?: unknown };
  // Sign-up messages from a content script act on the sender page's origin,
  // never on an origin named in the payload.
  const senderOrigin = sender.tab ? originOf(sender.url) : null;
  const fromExtensionPage = sender.url?.startsWith(browser.runtime.getURL("")) ?? false;
  switch (msg.type) {
    case "CONFIG_GET":
      return loadConfig();
    case "CONFIG_SET":
      return saveConfig(msg.payload as Config).then(() => true);
    case "VAULT_BYTES_GET":
      return getVaultBytesB64();
    case "VAULT_BYTES_SET": {
      const p = msg.payload as { b64: string; keepSession?: boolean };
      return setVaultBytesB64(p.b64, p.keepSession === true).then(() => true);
    }
    case "AUTOFILL_QUERY": {
      const p = msg.payload as { url: string; interactive?: boolean };
      return autofillQuery(p.url, p.interactive === true);
    }
    case "AUTOFILL_FILL":
      return autofillFill((msg.payload as { key: string }).key);
    case "AUTOFILL_OTP":
      return autofillOtp((msg.payload as { key: string }).key);
    case "VAULT_TOUCH":
      return touchCachedVault().then(() => true);
    case "GENERATE_PASSWORD": {
      const p = msg.payload as { minLength?: number; maxLength?: number };
      return isUnlocked().then((unlocked) =>
        unlocked
          ? { ok: true, password: generatePassword({ minLength: p.minLength, maxLength: p.maxLength }) }
          : { ok: false },
      );
    }
    case "GENERATED_PASSWORD_ACCEPT": {
      if (!senderOrigin) return Promise.resolve({ ok: false });
      const p = msg.payload as { username: string; password: string };
      return isUnlocked().then(async (unlocked) => {
        if (!unlocked || !p.password) return { ok: false };
        await setPending(senderOrigin, p.username, p.password);
        await touchCachedVault();
        return { ok: true };
      });
    }
    case "GENERATED_PASSWORD_SUBMIT": {
      if (!senderOrigin) return Promise.resolve({ ok: false, error: "Not a web page." });
      const p = msg.payload as { username: string; password: string };
      return saveFromSubmit(senderOrigin, p.username, p.password).then((res) => {
        if (!("skipped" in res)) notifySaveResult(sender.tab?.id, res);
        return res;
      });
    }
    // Popup-only: these name an origin explicitly, so refuse them from pages.
    case "PENDING_CREDENTIALS_LIST":
      if (!fromExtensionPage) return undefined;
      return listPending();
    case "PENDING_CREDENTIAL_SAVE":
      if (!fromExtensionPage) return undefined;
      return savePending((msg.payload as { origin: string }).origin);
    case "PENDING_CREDENTIAL_DISCARD":
      if (!fromExtensionPage) return undefined;
      return discardPending((msg.payload as { origin: string }).origin).then(() => true);
    case "OPEN_POPUP":
      return browser.action.openPopup().then(() => true).catch(() => false);
    default:
      return undefined;
  }
});
