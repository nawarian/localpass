/**
 * LocalPass Popup — 1Password-inspired UI
 *
 * Decryption happens here (popup is a stable page). The background only
 * stores config and encrypted bytes — service worker memory isn't reliable.
 */

import type { Config, Entry, Vault } from "@localpass/core";
import { s3Download } from "@localpass/core/dist/s3.js";
import { loadStore } from "@localpass/core/dist/store.js";
import { listKeys, getEntry } from "@localpass/core/dist/vault.js";

type UIState = "no_config" | "no_vault" | "locked" | "unlocked";

interface Settings {
  autoLockMinutes: number;
}

const SETTINGS_KEY = "localpass:settings";
const SESSION_VAULT_KEY = "localpass:cached_vault";
const DEFAULT_AUTO_LOCK_MIN = 5;

const app = document.getElementById("app")!;

let uiState: UIState = "locked";
let vault: Vault | null = null;
let selectedKey: string | null = null;
let searchQuery = "";

// ---------- settings & session cache ----------

async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  const min = stored?.autoLockMinutes;
  return {
    autoLockMinutes: typeof min === "number" && min > 0 ? min : DEFAULT_AUTO_LOCK_MIN,
  };
}

async function loadCachedVault(): Promise<Vault | null> {
  const result = await browser.storage.session.get(SESSION_VAULT_KEY);
  const cached = result[SESSION_VAULT_KEY] as { vault: Vault; expiresAt: number } | undefined;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    await browser.storage.session.remove(SESSION_VAULT_KEY);
    return null;
  }
  return cached.vault;
}

async function saveCachedVault(v: Vault): Promise<void> {
  const settings = await getSettings();
  const expiresAt = Date.now() + settings.autoLockMinutes * 60_000;
  await browser.storage.session.set({
    [SESSION_VAULT_KEY]: { vault: v, expiresAt },
  });
}

async function clearCachedVault(): Promise<void> {
  await browser.storage.session.remove(SESSION_VAULT_KEY);
}

const SITES_PROMPTED_KEY = "localpass:sites_prompted";

/**
 * Prompt for `<all_urls>` host permission once after the user has unlocked.
 * Without this, the in-page autofill dropdown can't appear on sites the user
 * hasn't manually approved. We respect the user's decision: if they accept
 * or dismiss, we never ask again — they can flip it later from Settings.
 */
async function maybeRequestSitesPermission(): Promise<void> {
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

// ---------- helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(name: string): string {
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

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return (await browser.runtime.sendMessage({ type, payload })) as T;
}

function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    flashToast(`${label} copied`);
  } catch {
    flashToast("Copy failed", true);
  }
}

function flashToast(text: string, error = false) {
  const t = el("div", {
    class: `pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-xs font-medium shadow-lg z-50 ${
      error ? "bg-red-500 text-white" : "bg-emerald-500 text-white"
    }`,
  });
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1300);
}

// ---------- bootstrap ----------

async function determineInitialState(): Promise<UIState> {
  const cfg = await send<Config | null>("CONFIG_GET");
  if (!cfg || !cfg.s3_bucket) return "no_config";
  const b64 = await send<string | null>("VAULT_BYTES_GET");
  if (!b64) return "no_vault";
  return "locked";
}

async function refresh() {
  if (!vault) {
    vault = await loadCachedVault();
  }
  if (vault) {
    uiState = "unlocked";
    if (selectedKey && !vault.entries[selectedKey]) selectedKey = null;
  } else {
    uiState = await determineInitialState();
    selectedKey = null;
  }
  render();
}

function render() {
  app.innerHTML = "";
  switch (uiState) {
    case "no_config":
      app.appendChild(renderNoConfig());
      break;
    case "no_vault":
      app.appendChild(renderNoVault());
      break;
    case "locked":
      app.appendChild(renderLocked());
      break;
    case "unlocked":
      app.appendChild(renderUnlocked());
      break;
  }
}

// ---------- empty states ----------

function renderNoConfig(): HTMLElement {
  const root = el("div", { class: "flex-1 flex flex-col items-center justify-center p-8 text-center" });
  root.append(
    el("div", { class: "w-14 h-14 rounded-full bg-surface-2 flex items-center justify-center mb-4" },
      iconKey("w-7 h-7 text-text-muted")
    ),
    el("h1", { class: "text-base font-semibold mb-2" }, "Welcome to LocalPass"),
    el("p", { class: "text-sm text-text-muted max-w-xs mb-5" },
      "Configure your S3 bucket and credentials to start syncing your encrypted vault."
    ),
    primaryButton("Open settings", () => browser.runtime.openOptionsPage())
  );
  return root;
}

function renderNoVault(): HTMLElement {
  const root = el("div", { class: "flex-1 flex flex-col" });
  root.append(renderHeaderSimple());
  const body = el("div", { class: "flex-1 flex flex-col items-center justify-center p-8 text-center" });
  body.append(
    el("div", { class: "w-14 h-14 rounded-full bg-surface-2 flex items-center justify-center mb-4" },
      iconCloud("w-7 h-7 text-text-muted")
    ),
    el("h1", { class: "text-base font-semibold mb-2" }, "No vault yet"),
    el("p", { class: "text-sm text-text-muted max-w-xs mb-5" },
      "Pull your encrypted vault from S3 to get started."
    ),
  );
  const pullBtn = primaryButton("Pull from S3", async () => {
    pullBtn.disabled = true;
    pullBtn.textContent = "Pulling…";
    const res = await pullFromS3();
    if (!res.ok) {
      flashToast(res.error || "Pull failed", true);
      pullBtn.disabled = false;
      pullBtn.textContent = "Pull from S3";
      return;
    }
    await refresh();
  });
  body.append(pullBtn);
  const settingsLink = el("button", {
    class: "mt-3 text-xs text-text-muted hover:text-text underline",
  }, "Open settings");
  settingsLink.addEventListener("click", () => browser.runtime.openOptionsPage());
  body.append(settingsLink);
  root.append(body);
  return root;
}

function renderLocked(): HTMLElement {
  const root = el("div", { class: "flex-1 flex flex-col" });
  root.append(renderHeaderSimple());

  const body = el("div", { class: "flex-1 flex flex-col items-center justify-center p-8" });
  body.append(
    el("div", { class: "w-14 h-14 rounded-full bg-surface-2 flex items-center justify-center mb-4" },
      iconLock("w-7 h-7 text-text-muted")
    ),
    el("h1", { class: "text-base font-semibold mb-1" }, "Vault locked"),
    el("p", { class: "text-sm text-text-muted mb-5" }, "Enter your master password to unlock.")
  );

  const form = el("form", { class: "w-full max-w-xs flex flex-col gap-3" });
  const pwInput = el("input", {
    type: "password",
    autocomplete: "off",
    placeholder: "Master password",
    class:
      "w-full bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2.5 text-sm placeholder:text-text-dim",
  }) as HTMLInputElement;
  const errorMsg = el("div", { class: "text-xs text-red-400 min-h-[1rem]" });
  const unlockBtn = primaryButton("Unlock", () => {});
  unlockBtn.setAttribute("type", "submit");

  form.append(pwInput, errorMsg, unlockBtn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorMsg.textContent = "";
    if (!pwInput.value) {
      errorMsg.textContent = "Enter your master password.";
      return;
    }
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Unlocking…";
    try {
      const b64 = await send<string | null>("VAULT_BYTES_GET");
      if (!b64) {
        errorMsg.textContent = "No vault data. Pull from S3 first.";
        unlockBtn.disabled = false;
        unlockBtn.textContent = "Unlock";
        return;
      }
      vault = await loadStore(base64ToBytes(b64), pwInput.value);
      await saveCachedVault(vault);
      await maybeRequestSitesPermission();
      await refresh();
    } catch (err) {
      const msg = (err as Error).message;
      if (/wrong master password|WRONG_PASSWORD/i.test(msg)) {
        errorMsg.textContent = "Wrong master password.";
      } else {
        errorMsg.textContent = msg;
      }
      unlockBtn.disabled = false;
      unlockBtn.textContent = "Unlock";
      pwInput.select();
    }
  });

  body.append(form);
  setTimeout(() => pwInput.focus(), 50);
  root.append(body);
  return root;
}

// ---------- unlocked: list + detail ----------

function renderUnlocked(): HTMLElement {
  const root = el("div", { class: "flex-1 flex flex-col min-h-0" });
  root.append(renderTopBar());

  const main = el("div", { class: "flex-1 flex min-h-0" });
  const keys = vault ? listKeys(vault) : [];

  // Sidebar
  const sidebar = el("div", { class: "w-[200px] border-r border-border bg-surface flex flex-col min-h-0" });

  sidebar.append(
    el("div", { class: "px-3 py-2.5 border-b border-border flex items-center gap-2 text-sm" },
      iconList("w-4 h-4 text-text-muted"),
      el("span", { class: "font-medium" }, "All Items"),
      el("span", { class: "ml-auto text-xs text-text-dim" }, String(keys.length))
    )
  );

  const list = el("ul", { class: "flex-1 overflow-y-auto py-1" });

  const filtered = keys.filter((k) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    if (k.toLowerCase().includes(q)) return true;
    const e = vault!.entries[k];
    const username = e?.metadata?.["username"] || e?.metadata?.["email"] || "";
    return username.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    list.append(
      el("li", { class: "px-3 py-6 text-center text-xs text-text-dim" },
        searchQuery ? "No matches" : "Vault is empty"
      )
    );
  }

  for (const key of filtered) {
    const entry = vault!.entries[key];
    const isSelected = key === selectedKey;
    const username = entry?.metadata?.["username"] || entry?.metadata?.["email"] || "";
    const li = el("li", {});
    const btn = el("button", {
      class: `w-full text-left px-2.5 py-2 mx-1 my-0.5 rounded-md flex items-center gap-2.5 transition-colors ${
        isSelected ? "bg-accent text-white" : "hover:bg-surface-2 text-text"
      }`,
    });
    const avatar = el("div", {
      class: `w-8 h-8 rounded-md flex-shrink-0 flex items-center justify-center text-[11px] font-semibold text-white ${colorFor(key)}`,
    }, initials(key));
    const text = el("div", { class: "flex-1 min-w-0" });
    text.append(
      el("div", { class: "text-sm font-medium truncate" }, key),
      el("div", {
        class: `text-xs truncate ${isSelected ? "text-white/80" : "text-text-muted"}`,
      }, username || "—")
    );
    btn.append(avatar, text);
    btn.addEventListener("click", () => {
      selectedKey = key;
      render();
    });
    li.append(btn);
    list.append(li);
  }

  sidebar.append(list);
  main.append(sidebar);

  // Detail pane
  main.append(renderDetailPane());
  root.append(main);
  return root;
}

function renderDetailPane(): HTMLElement {
  const pane = el("div", { class: "flex-1 min-w-0 flex flex-col bg-bg" });

  const entry: Entry | undefined = selectedKey && vault ? getEntry(vault, selectedKey) : undefined;

  if (!selectedKey || !entry) {
    pane.append(
      el("div", { class: "flex-1 flex flex-col items-center justify-center text-center p-6" },
        el("div", { class: "w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mb-3" },
          iconKey("w-6 h-6 text-text-muted")
        ),
        el("p", { class: "text-sm text-text-muted" }, "Select an item to view details")
      )
    );
    return pane;
  }

  const meta = entry.metadata || {};
  const username = meta["username"] || meta["email"] || "";
  const password = meta["password"] || "";
  const website = meta["url"] || meta["website"] || "";
  const standard = new Set(["username", "email", "password", "url", "website", "notes"]);
  const customFields = Object.entries(meta).filter(([k]) => !standard.has(k));

  // Header strip
  const header = el("div", {
    class: "px-4 py-3 border-b border-border flex items-center gap-2",
  });
  const avatar = el("div", {
    class: `w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-semibold text-white ${colorFor(selectedKey)}`,
  }, initials(selectedKey));
  header.append(
    avatar,
    el("span", { class: "text-sm font-medium truncate max-w-[140px]" }, selectedKey),
    el("span", {
      class: "text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded-full border border-border",
    }, "Personal"),
  );
  const fillBtn = el("button", {
    class: "ml-auto text-xs font-medium border border-accent/60 text-accent hover:bg-accent hover:text-white rounded-full px-3 py-1 transition-colors",
  }, "Open & Fill");
  fillBtn.addEventListener("click", () => {
    if (website) browser.tabs.create({ url: ensureHttp(website) });
    if (password) void copyToClipboard(password, "Password");
  });
  header.append(fillBtn);
  pane.append(header);

  const body = el("div", { class: "flex-1 overflow-y-auto p-4 space-y-3" });

  const card = el("div", { class: "flex items-center gap-3" });
  card.append(
    el("div", {
      class: `w-12 h-12 rounded-lg flex items-center justify-center text-base font-semibold text-white ${colorFor(selectedKey)}`,
    }, initials(selectedKey)),
    el("div", { class: "min-w-0" },
      el("div", { class: "text-lg font-semibold truncate" }, selectedKey),
    )
  );
  body.append(card);

  const fields = el("div", { class: "rounded-lg bg-surface border border-border divide-y divide-border" });
  if (username) fields.append(renderField("username", username, false));
  if (password) fields.append(renderField("password", password, true));
  for (const [k, v] of customFields) fields.append(renderField(k, v, /pass|secret|token/i.test(k)));
  if (fields.children.length > 0) body.append(fields);

  if (website) {
    const link = el("a", {
      href: ensureHttp(website),
      target: "_blank",
      rel: "noopener noreferrer",
      class: "block text-sm rounded-lg bg-surface border border-border px-3 py-2.5 hover:border-border-strong transition-colors",
    });
    link.append(
      el("div", { class: "text-[11px] uppercase tracking-wider text-text-muted mb-0.5" }, "website"),
      el("div", { class: "text-accent truncate" }, website)
    );
    body.append(link);
  }

  if (meta["notes"]) {
    body.append(
      el("div", { class: "rounded-lg bg-surface border border-border px-3 py-2.5" },
        el("div", { class: "text-[11px] uppercase tracking-wider text-text-muted mb-1" }, "notes"),
        el("div", { class: "text-sm whitespace-pre-wrap" }, meta["notes"])
      )
    );
  }

  pane.append(body);
  return pane;
}

function renderField(label: string, value: string, secret: boolean): HTMLElement {
  const row = el("div", { class: "px-3 py-2.5 flex items-center gap-3 group" });
  const main = el("div", { class: "flex-1 min-w-0" });
  main.append(
    el("div", { class: "text-[11px] uppercase tracking-wider text-text-muted mb-0.5" }, label)
  );
  const valEl = el("div", { class: "text-sm truncate font-mono" });

  let revealed = !secret;
  const setText = () => {
    valEl.textContent = revealed ? value : "•".repeat(Math.min(value.length, 14));
  };
  setText();
  main.append(valEl);
  row.append(main);

  if (secret) {
    const eye = el("button", {
      class: "text-text-muted hover:text-text p-1 rounded",
      title: "Reveal",
    }, iconEye("w-4 h-4"));
    eye.addEventListener("click", () => {
      revealed = !revealed;
      setText();
    });
    row.append(eye);
  }

  const copy = el("button", {
    class: "text-text-muted hover:text-text p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity",
    title: `Copy ${label}`,
  }, iconCopy("w-4 h-4"));
  copy.addEventListener("click", () => copyToClipboard(value, label));
  row.append(copy);

  return row;
}

function ensureHttp(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

// ---------- top bars ----------

function renderTopBar(): HTMLElement {
  const bar = el("div", {
    class: "flex items-center gap-2 px-3 py-2 border-b border-border bg-surface",
  });

  const search = el("div", {
    class: "flex-1 flex items-center gap-2 bg-surface-2 border border-border rounded-md px-2.5 py-1.5",
  });
  search.append(iconSearch("w-4 h-4 text-text-muted"));
  const input = el("input", {
    type: "search",
    placeholder: "Search LocalPass",
    class: "flex-1 bg-transparent outline-none text-sm placeholder:text-text-dim",
  }) as HTMLInputElement;
  input.value = searchQuery;
  input.id = "search-input";
  input.addEventListener("input", () => {
    searchQuery = input.value;
    render();
    const next = document.getElementById("search-input") as HTMLInputElement | null;
    if (next) {
      next.focus();
      const len = next.value.length;
      next.setSelectionRange(len, len);
    }
  });
  search.append(input);
  bar.append(search);

  const lock = el("button", {
    class: "text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2",
    title: "Lock vault",
  }, iconLock("w-4 h-4"));
  lock.addEventListener("click", async () => {
    vault = null;
    selectedKey = null;
    searchQuery = "";
    await clearCachedVault();
    await refresh();
  });
  bar.append(lock);

  const settings = el("button", {
    class: "text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2",
    title: "Settings",
  }, iconGear("w-4 h-4"));
  settings.addEventListener("click", () => browser.runtime.openOptionsPage());
  bar.append(settings);

  return bar;
}

function renderHeaderSimple(): HTMLElement {
  const bar = el("div", {
    class: "flex items-center gap-2 px-3 py-2.5 border-b border-border bg-surface",
  });
  bar.append(
    el("div", {
      class: "w-6 h-6 rounded-md bg-gradient-to-br from-teal-400 to-teal-600 flex items-center justify-center",
    }, iconKey("w-3.5 h-3.5 text-white")),
    el("div", { class: "text-sm font-semibold" }, "LocalPass")
  );
  const settings = el("button", {
    class: "ml-auto text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2",
    title: "Settings",
  }, iconGear("w-4 h-4"));
  settings.addEventListener("click", () => browser.runtime.openOptionsPage());
  bar.append(settings);
  return bar;
}

// ---------- shared UI ----------

function primaryButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = el("button", {
    class:
      "bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors",
  }) as HTMLButtonElement;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- S3 pull ----------

async function pullFromS3(): Promise<{ ok: true } | { ok: false; error: string }> {
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

// ---------- icons ----------

function svgIcon(path: string, cls: string, viewBox = "0 0 24 24"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", cls);
  svg.innerHTML = path;
  return svg;
}

function iconSearch(cls: string) {
  return svgIcon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', cls);
}
function iconLock(cls: string) {
  return svgIcon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', cls);
}
function iconKey(cls: string) {
  return svgIcon('<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9"/><path d="M16 6l3 3"/>', cls);
}
function iconCloud(cls: string) {
  return svgIcon('<path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7 1.5A4 4 0 0 0 6 18z"/>', cls);
}
function iconList(cls: string) {
  return svgIcon('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', cls);
}
function iconCopy(cls: string) {
  return svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', cls);
}
function iconEye(cls: string) {
  return svgIcon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>', cls);
}
function iconGear(cls: string) {
  return svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', cls);
}

// ---------- boot ----------

refresh().catch((e) => {
  console.error(e);
  app.innerHTML = `<div class="p-6 text-sm text-red-400">Error: ${(e as Error).message}</div>`;
});
