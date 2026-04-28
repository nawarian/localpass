/**
 * LocalPass Background Script
 *
 * Stores config and encrypted vault bytes. The decrypted vault is cached in
 * browser.storage.session (in-memory, owned by the popup). Background reads
 * it to serve autofill requests from content scripts.
 */

import type { Config, Vault } from "@localpass/core";

const CONFIG_KEY = "localpass:config";
const VAULT_KEY = "localpass:vault";
const SESSION_VAULT_KEY = "localpass:cached_vault";

async function loadConfig(): Promise<Config | null> {
  const result = await browser.storage.local.get(CONFIG_KEY);
  return (result[CONFIG_KEY] as Config) ?? null;
}

async function saveConfig(config: Config): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

async function getVaultBytesB64(): Promise<string | null> {
  const result = await browser.storage.local.get(VAULT_KEY);
  return (result[VAULT_KEY] as string | undefined) ?? null;
}

async function setVaultBytesB64(b64: string, keepSession = false): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: b64 });
  if (!keepSession) {
    // New bytes may have been encrypted with a different password, so the
    // previously cached unlocked vault is no longer valid. Force re-unlock.
    await browser.storage.session.remove(SESSION_VAULT_KEY);
  }
}

async function readCachedVault(): Promise<Vault | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as { vault: Vault; expiresAt: number } | undefined;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    return null;
  }
  return cached.vault;
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

type AutofillEntry = { key: string; username: string };

type AutofillQueryResult =
  | { state: "no_vault" }
  | { state: "locked" }
  | { state: "unlocked"; matches: AutofillEntry[]; others: AutofillEntry[] };

async function autofillQuery(pageUrl: string): Promise<AutofillQueryResult> {
  // Fast path: if a session vault is cached, skip the local-storage bytes
  // check entirely — saves one round-trip on the common (unlocked) case.
  const vault = await readCachedVault();
  if (!vault) {
    const bytes = await getVaultBytesB64();
    if (!bytes) return { state: "no_vault" };
    return { state: "locked" };
  }

  const pageHost = hostnameOf(pageUrl);
  const matches: AutofillEntry[] = [];
  const others: AutofillEntry[] = [];

  for (const [key, entry] of Object.entries(vault.entries)) {
    const meta = entry.metadata || {};
    const username = meta["username"] || meta["email"] || "";
    const summary: AutofillEntry = { key, username };

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
  const meta = entry.metadata || {};
  return {
    ok: true,
    username: meta["username"] || meta["email"] || "",
    password: meta["password"] || "",
  };
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

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && SESSION_VAULT_KEY in changes) {
    void broadcastVaultUpdate();
  } else if (areaName === "local" && VAULT_KEY in changes) {
    void broadcastVaultUpdate();
  }
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type: string; payload?: unknown };
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
    case "AUTOFILL_QUERY":
      return autofillQuery((msg.payload as { url: string }).url);
    case "AUTOFILL_FILL":
      return autofillFill((msg.payload as { key: string }).key);
    case "OPEN_POPUP":
      return browser.action.openPopup().then(() => true).catch(() => false);
    default:
      return undefined;
  }
});
