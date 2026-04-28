/**
 * LocalPass content script — autofill on login forms.
 *
 * Detects password inputs, overlays a small LocalPass icon, and on click
 * shows a dropdown of matching entries from the vault. Selecting an entry
 * fills the username + password fields and dispatches input/change events
 * so frameworks (React, Vue, etc.) see the value.
 */

type AutofillEntry = { key: string; username: string };

type QueryResult =
  | { state: "no_vault" }
  | { state: "locked" }
  | { state: "unlocked"; matches: AutofillEntry[]; others: AutofillEntry[] };

const ICON_SIZE = 22;
const Z_BASE = 2147483640;

const ATTR_HOOKED = "data-localpass-hooked";

let activeIndicator: HTMLElement | null = null;
let activeDropdown: HTMLElement | null = null;
let activeField: HTMLInputElement | null = null;

// Local cache fed by AUTOFILL_QUERY on load and refreshed via VAULT_STATE_PUSH
// from the background. Lets the dropdown open instantly without waiting for a
// service-worker round-trip on every focus.
let cachedResult: QueryResult | null = null;
let inflightQuery: Promise<QueryResult> | null = null;

function refreshCache(): Promise<QueryResult> {
  if (inflightQuery) return inflightQuery;
  inflightQuery = sendMessage<QueryResult>("AUTOFILL_QUERY", { url: location.href })
    .then((r) => {
      cachedResult = r;
      return r;
    })
    .finally(() => {
      inflightQuery = null;
    });
  return inflightQuery;
}

// ---------- detection ----------

function isInteractableInput(node: Element | null): node is HTMLInputElement {
  if (!(node instanceof HTMLInputElement)) return false;
  if (node.disabled || node.readOnly) return false;
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 10) return false;
  return true;
}

function isPasswordInput(node: Element | null): node is HTMLInputElement {
  return isInteractableInput(node) && node.type === "password";
}

/**
 * Heuristic: does this input look like a username/email/login field?
 * Strong signals (autocomplete=username/email, type=email) win immediately;
 * otherwise fall back to keyword matching across name/id/aria/placeholder.
 */
function isUsernameLikeInput(node: Element | null): node is HTMLInputElement {
  if (!isInteractableInput(node)) return false;
  const t = node.type;
  if (t === "password") return false;
  if (t !== "text" && t !== "email" && t !== "tel" && t !== "") return false;

  const ac = (node.getAttribute("autocomplete") || "").toLowerCase();
  if (/(^|\s)(username|email)(\s|$)/.test(ac)) return true;
  if (t === "email") return true;

  const tokens = [
    node.name || "",
    node.id || "",
    node.getAttribute("aria-label") || "",
    node.getAttribute("aria-labelledby") || "",
    node.placeholder || "",
  ]
    .join(" ")
    .toLowerCase();

  return /\b(user(name)?|email|login|account|signin)\b/.test(tokens);
}

function isAutofillTarget(node: Element | null): node is HTMLInputElement {
  return isPasswordInput(node) || isUsernameLikeInput(node);
}

function findUsernameInput(passwordInput: HTMLInputElement): HTMLInputElement | null {
  const form = passwordInput.form;
  const candidates: HTMLInputElement[] = [];
  const scope: ParentNode = form ?? document;
  scope.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
  ).forEach((el) => {
    if (el.disabled || el.readOnly) return;
    candidates.push(el);
  });

  // 1. autocomplete=username
  const byAutocomplete = candidates.find((el) =>
    /username|email/i.test(el.getAttribute("autocomplete") || "")
  );
  if (byAutocomplete) return byAutocomplete;

  // 2. nearest preceding candidate (in DOM order)
  const passwordIdx = (() => {
    const all = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
    return all.indexOf(passwordInput);
  })();
  let best: HTMLInputElement | null = null;
  for (const c of candidates) {
    const all = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
    const idx = all.indexOf(c);
    if (idx >= 0 && idx < passwordIdx) best = c;
  }
  return best ?? candidates[0] ?? null;
}

function findPasswordInputFor(usernameInput: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = usernameInput.form ?? document;
  const all = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
  const idx = all.indexOf(usernameInput);
  // prefer a password field that comes after the username in DOM order
  for (let i = idx + 1; i < all.length; i++) {
    if (isPasswordInput(all[i])) return all[i];
  }
  // fallback: any visible password in the form/document
  for (const el of all) if (isPasswordInput(el)) return el;
  return null;
}

// ---------- indicator overlay ----------

function positionOverPasswordField(target: HTMLElement, anchor: HTMLInputElement) {
  const rect = anchor.getBoundingClientRect();
  const top = window.scrollY + rect.top + (rect.height - ICON_SIZE) / 2;
  const left = window.scrollX + rect.right - ICON_SIZE - 6;
  target.style.top = `${top}px`;
  target.style.left = `${left}px`;
}

function createIndicator(input: HTMLInputElement): HTMLElement {
  const host = document.createElement("localpass-indicator");
  host.style.cssText = `
    position: absolute;
    width: ${ICON_SIZE}px;
    height: ${ICON_SIZE}px;
    z-index: ${Z_BASE};
    pointer-events: auto;
  `;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .btn {
        width: 100%;
        height: 100%;
        border-radius: 6px;
        border: 1px solid rgba(99,102,241,0.4);
        background: rgba(26,26,28,0.92);
        color: #c7d2fe;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        transition: background 0.15s, border-color 0.15s;
      }
      .btn:hover { background: #6366f1; color: white; border-color: #6366f1; }
      .btn svg { width: 14px; height: 14px; }
    </style>
    <button class="btn" type="button" aria-label="Open LocalPass">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="14" r="4"/><path d="M11 11l9-9"/><path d="M16 6l3 3"/>
      </svg>
    </button>
  `;
  positionOverPasswordField(host, input);

  const btn = shadow.querySelector("button")!;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openDropdown(input);
  });

  document.documentElement.appendChild(host);
  return host;
}

function clearIndicator() {
  activeIndicator?.remove();
  activeIndicator = null;
}

function clearDropdown() {
  activeDropdown?.remove();
  activeDropdown = null;
}

// ---------- dropdown ----------

async function openDropdown(input: HTMLInputElement) {
  clearDropdown();
  activeField = input;

  if (cachedResult) {
    showDropdown(input, cachedResult);
    // refresh in the background so subsequent opens stay fresh, but don't
    // make the user wait
    refreshCache().catch(() => {});
    return;
  }

  showLoadingDropdown(input);
  try {
    const result = await refreshCache();
    if (activeField !== input) return;
    clearDropdown();
    showDropdown(input, result);
  } catch {
    if (activeField === input) clearDropdown();
  }
}

function showLoadingDropdown(input: HTMLInputElement) {
  const host = document.createElement("localpass-dropdown");
  const rect = input.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 4;
  const left = window.scrollX + rect.left;
  const width = Math.max(rect.width, 280);
  host.style.cssText = `
    position: absolute;
    top: ${top}px;
    left: ${left}px;
    width: ${width}px;
    z-index: ${Z_BASE + 1};
    pointer-events: auto;
  `;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        background: #1a1a1c; color: #9b9ba1;
        border: 1px solid #2e2e33; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 12px; padding: 14px; text-align: center;
      }
    </style>
    <div class="panel">Loading…</div>
  `;
  document.documentElement.appendChild(host);
  activeDropdown = host;
}

function showDropdown(input: HTMLInputElement, result: QueryResult) {
  const host = document.createElement("localpass-dropdown");
  const rect = input.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 4;
  const left = window.scrollX + rect.left;
  const width = Math.max(rect.width, 280);

  host.style.cssText = `
    position: absolute;
    top: ${top}px;
    left: ${left}px;
    width: ${width}px;
    z-index: ${Z_BASE + 1};
    pointer-events: auto;
  `;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        background: #1a1a1c;
        color: #e8e8ea;
        border: 1px solid #2e2e33;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        overflow: hidden;
        max-height: 320px;
        display: flex;
        flex-direction: column;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: #232326;
        border-bottom: 1px solid #2e2e33;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #9b9ba1;
      }
      .header .brand {
        color: #c7d2fe;
        font-weight: 600;
        text-transform: none;
        letter-spacing: 0;
        font-size: 12px;
      }
      .list { overflow-y: auto; flex: 1; padding: 4px; }
      .group-label {
        padding: 6px 10px 4px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #6e6e75;
      }
      .item {
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        color: inherit;
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        font: inherit;
      }
      .item:hover, .item:focus { background: #2c2c30; outline: none; }
      .avatar {
        width: 26px; height: 26px;
        border-radius: 6px;
        background: #6366f1;
        color: white;
        font-size: 10px;
        font-weight: 600;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .meta { flex: 1; min-width: 0; }
      .meta .key { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .meta .user { font-size: 11px; color: #9b9ba1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .empty {
        padding: 16px 12px;
        text-align: center;
        color: #9b9ba1;
        font-size: 12px;
      }
      .action {
        background: #6366f1;
        color: white;
        padding: 7px 12px;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        margin: 6px 10px 10px;
      }
      .action:hover { background: #5b5fe0; }
    </style>
    <div class="panel">
      <div class="header">
        <span class="brand">LocalPass</span>
      </div>
      <div class="list" id="list"></div>
    </div>
  `;

  const list = shadow.getElementById("list")!;

  if (result.state === "no_vault") {
    list.innerHTML = `<div class="empty">No vault yet.<br/>Open LocalPass to set up.</div>`;
    list.appendChild(makeOpenPopupButton(shadow, "Open LocalPass"));
  } else if (result.state === "locked") {
    list.innerHTML = `<div class="empty"><strong style="color:#e8e8ea">Vault is locked</strong><br/>Click below to unlock and autofill.</div>`;
    list.appendChild(makeOpenPopupButton(shadow, "Unlock LocalPass"));
  } else {
    const all = [...result.matches, ...result.others];
    if (all.length === 0) {
      list.innerHTML = `<div class="empty">Vault is empty.</div>`;
    } else {
      if (result.matches.length > 0) {
        const lbl = document.createElement("div");
        lbl.className = "group-label";
        lbl.textContent = "Matches this site";
        list.appendChild(lbl);
        for (const e of result.matches) list.appendChild(makeItem(e));
      }
      if (result.others.length > 0) {
        const lbl = document.createElement("div");
        lbl.className = "group-label";
        lbl.textContent = result.matches.length > 0 ? "Other items" : "All items";
        list.appendChild(lbl);
        for (const e of result.others) list.appendChild(makeItem(e));
      }
    }
  }

  document.documentElement.appendChild(host);
  activeDropdown = host;

  // close on outside click / scroll / escape
  setTimeout(() => document.addEventListener("mousedown", onOutsideMouseDown, true), 0);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", clearDropdown, { passive: true, once: true });
}

function makeItem(entry: AutofillEntry): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "item";
  btn.type = "button";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.style.background = colorFor(entry.key);
  avatar.textContent = initials(entry.key);
  const meta = document.createElement("div");
  meta.className = "meta";
  const key = document.createElement("div");
  key.className = "key";
  key.textContent = entry.key;
  const user = document.createElement("div");
  user.className = "user";
  user.textContent = entry.username || "—";
  meta.appendChild(key);
  meta.appendChild(user);
  btn.appendChild(avatar);
  btn.appendChild(meta);
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await fillEntry(entry.key);
    clearDropdown();
  });
  return btn;
}

function makeOpenPopupButton(shadow: ShadowRoot, label = "Open LocalPass"): HTMLElement {
  void shadow;
  const btn = document.createElement("button");
  btn.className = "action";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await sendMessage("OPEN_POPUP", {});
    clearDropdown();
  });
  return btn;
}

function onOutsideMouseDown(e: MouseEvent) {
  if (!activeDropdown) return;
  const path = e.composedPath();
  if (path.includes(activeDropdown) || (activeIndicator && path.includes(activeIndicator))) return;
  clearDropdown();
  document.removeEventListener("mousedown", onOutsideMouseDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    clearDropdown();
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  }
}

// ---------- fill ----------

async function fillEntry(key: string) {
  if (!activeField) return;
  const res = await sendMessage<{ ok: false } | { ok: true; username: string; password: string }>(
    "AUTOFILL_FILL",
    { key }
  );
  if (!res.ok) return;

  // Find both fields regardless of which one is currently focused. The user
  // may have triggered autofill from the username or password input — we fill
  // whatever is present in the form.
  const passwordInput =
    activeField.type === "password" ? activeField : findPasswordInputFor(activeField);
  const usernameInput =
    activeField.type === "password" ? findUsernameInput(activeField) : activeField;

  if (usernameInput && res.username) setNativeValue(usernameInput, res.username);
  if (passwordInput && res.password) setNativeValue(passwordInput, res.password);
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = desc?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

// ---------- helpers ----------

async function sendMessage<T = unknown>(type: string, payload: unknown): Promise<T> {
  return (await browser.runtime.sendMessage({ type, payload })) as T;
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(name: string): string {
  const palette = ["#6366f1", "#10b981", "#f43f5e", "#f59e0b", "#0ea5e9", "#d946ef", "#14b8a6", "#f97316"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// ---------- attach to inputs ----------

function attachTo(input: HTMLInputElement) {
  if (input.getAttribute(ATTR_HOOKED) === "1") return;
  input.setAttribute(ATTR_HOOKED, "1");

  const onFocus = () => {
    if (!isAutofillTarget(input)) return;
    activeField = input;
    clearIndicator();
    activeIndicator = createIndicator(input);
    // Auto-open the dropdown when the user lands on an empty field so they
    // don't have to take a second click. If the field already has a value
    // (page restore, paste manager, etc.) we stay out of the way.
    if (!input.value) void openDropdown(input);
  };

  const onBlur = (e: FocusEvent) => {
    // keep indicator/dropdown if focus moved into our shadow elements
    setTimeout(() => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "LOCALPASS-INDICATOR" || active.tagName === "LOCALPASS-DROPDOWN")
      ) {
        return;
      }
      if (!activeDropdown) clearIndicator();
    }, 100);
    void e;
  };

  // If the user starts typing, dismiss the dropdown — they're not picking from it.
  const onInput = () => {
    if (activeDropdown) clearDropdown();
  };

  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("input", onInput);
  if (document.activeElement === input) onFocus();
}

function scan(root: ParentNode = document) {
  root.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
    if (isAutofillTarget(el)) attachTo(el);
  });
}

// Prime the cache as soon as the content script loads so that by the time the
// user focuses an input, results are ready. Also wakes the background SW.
refreshCache().catch(() => {});

// Background pushes us updates when the vault state changes (unlock/lock/pull
// or auto-lock expiry). Refresh our local cache, and if a dropdown is open,
// re-render it with the fresh data.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string };
  if (msg?.type === "VAULT_STATE_PUSH") {
    refreshCache()
      .then((result) => {
        if (activeDropdown && activeField) {
          clearDropdown();
          showDropdown(activeField, result);
        }
      })
      .catch(() => {});
  }
});

// initial + observe
scan();
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach((n) => {
      if (n instanceof HTMLElement) {
        if (n instanceof HTMLInputElement && isAutofillTarget(n)) {
          attachTo(n);
        } else {
          scan(n);
        }
      }
    });
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener("resize", () => {
  if (activeIndicator && activeField) positionOverPasswordField(activeIndicator, activeField);
  if (activeDropdown) clearDropdown();
});
window.addEventListener("scroll", () => {
  if (activeIndicator && activeField) positionOverPasswordField(activeIndicator, activeField);
}, { passive: true });
