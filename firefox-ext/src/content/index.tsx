/**
 * LocalPass content script — autofill on login forms.
 *
 * Detects password inputs, overlays a small LocalPass icon, and on click
 * shows a dropdown of matching entries from the vault. Selecting an entry
 * fills the username + password fields and dispatches input/change events
 * so frameworks (React, Vue, etc.) see the value. One-time-code inputs get
 * the same overlay, listing only entries with a TOTP secret; picking one fills
 * the code that is valid at click time. Password inputs on sign-up forms get a
 * "Use generated password" section; when the form is submitted, the background
 * saves the credential to the vault and syncs it.
 *
 * Detection (field matching, MutationObserver, focusin fallback, fill) is all
 * vanilla. Only the shadow-DOM indicator + dropdown UI is rendered with Preact
 * into a closed shadow root; Tailwind can't cross the shadow boundary, so the
 * scoped <style> blocks are rendered straight into each shadow root.
 */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Logo } from "../popup/icons";

type AutofillEntry = { key: string; username: string; hasOtp: boolean };

type QueryResult =
  | { state: "no_vault" }
  | { state: "locked" }
  | { state: "unlocked"; matches: AutofillEntry[]; others: AutofillEntry[] };

const ICON_SIZE = 22;
const Z_BASE = 2147483640;

const ATTR_HOOKED = "data-localpass-hooked";
const ATTR_ORIG_AUTOCOMPLETE = "data-localpass-orig-autocomplete";

let activeIndicator: HTMLElement | null = null;
let activeDropdown: HTMLElement | null = null;
let activeField: HTMLInputElement | null = null;

// Local cache fed by AUTOFILL_QUERY on load and refreshed via VAULT_STATE_PUSH
// from the background. Lets the dropdown open instantly without waiting for a
// service-worker round-trip on every focus.
let cachedResult: QueryResult | null = null;
let inflightQuery: Promise<QueryResult> | null = null;

/**
 * Query the background for matching entries and refresh the local cache.
 *
 * `interactive` distinguishes a genuine user action (opening the dropdown,
 * which should reset the sliding auto-lock timer) from the automatic
 * page-load prime / state-push refresh (which must NOT touch the timer, or an
 * idle tab would keep the vault unlocked forever). When a query is already
 * in flight we still upgrade it to interactive if this caller is interactive,
 * so an open-dropdown right after a prime still counts.
 */
function refreshCache(interactive = false): Promise<QueryResult> {
  if (inflightQuery) {
    if (interactive) void sendMessage("VAULT_TOUCH", {}).catch(() => {});
    return inflightQuery;
  }
  inflightQuery = sendMessage<QueryResult>("AUTOFILL_QUERY", { url: location.href, interactive })
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

/**
 * Attribute-only candidate check. Doesn't query layout — safe to call right
 * after a node is inserted, before Gmail-style late-rendered inputs have a
 * non-zero bounding box.
 */
function isCandidateInput(node: Element | null): node is HTMLInputElement {
  if (!(node instanceof HTMLInputElement)) return false;
  if (node.disabled || node.readOnly) return false;
  // Hidden / type=hidden inputs aren't candidates, but `display:none` should
  // be checked at UI time, not here — Gmail wraps fields in containers that
  // are display:none for a tick.
  if (node.type === "hidden") return false;
  return true;
}

/**
 * Layout / visibility check. Use before showing the LocalPass indicator or
 * dropdown so we don't decorate honeypot fields or 0-size traps.
 */
function isVisibleEnough(node: HTMLInputElement): boolean {
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 10) return false;
  return true;
}

function isPasswordInput(node: Element | null): node is HTMLInputElement {
  return isCandidateInput(node) && node.type === "password";
}

/**
 * The page's own autocomplete tokens. attachTo() overwrites the attribute with
 * "off" to silence the native dropdown, so prefer the stashed original.
 */
function autocompleteTokens(node: HTMLInputElement): string[] {
  const ac = node.getAttribute(ATTR_ORIG_AUTOCOMPLETE) ?? node.getAttribute("autocomplete") ?? "";
  return ac.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Visible label text for the input: associated <label>s plus the elements
 * named by aria-labelledby. Frameworks like AWS's awsui leave name/placeholder
 * empty and describe the field only through `<label for>`. Capped so a label
 * wrapping a whole form section can't drag in unrelated keywords.
 */
function labelText(node: HTMLInputElement): string {
  const parts: string[] = [];
  node.labels?.forEach((l) => parts.push(l.textContent || ""));
  for (const id of (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
    parts.push(document.getElementById(id)?.textContent || "");
  }
  return parts
    .map((p) => p.replace(/\s+/g, " ").trim().slice(0, 80))
    .join(" ");
}

/**
 * Heuristic: is this a one-time-code (2FA) input? `autocomplete=one-time-code`
 * or an explicit otp/2fa/mfa keyword is enough; a bare "code" keyword also
 * needs a numeric hint (inputmode/type) or a 6–8 char maxlength, so promo and
 * postal code fields don't match.
 */
function isOtpInput(node: Element | null): boolean {
  if (!isCandidateInput(node)) return false;
  const t = node.type;
  if (t !== "text" && t !== "tel" && t !== "number" && t !== "") return false;
  if (autocompleteTokens(node).includes("one-time-code")) return true;

  const words = [
    node.name || "",
    node.id || "",
    node.getAttribute("aria-label") || "",
    node.placeholder || "",
    labelText(node),
  ]
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // totpCode → totp Code
    .replace(/[_-]+/g, " ")
    .toLowerCase();

  if (/\b(otp|totp|2fa|mfa|one ?time|two ?factor)\b/.test(words)) return true;
  if (/\bcode\b/.test(words)) {
    const numeric = node.getAttribute("inputmode") === "numeric" || t === "tel" || t === "number";
    const len = node.maxLength;
    return numeric || (len >= 6 && len <= 8);
  }
  return false;
}

/**
 * Heuristic: does this input look like a username/email/login field?
 * Strong signals (autocomplete=username/email, type=email) win immediately;
 * otherwise fall back to keyword matching across name/id/aria/placeholder.
 */
function isUsernameLikeInput(node: Element | null): node is HTMLInputElement {
  if (!isCandidateInput(node)) return false;
  const t = node.type;
  if (t === "password") return false;
  if (t !== "text" && t !== "email" && t !== "tel" && t !== "") return false;
  if (isOtpInput(node)) return false;

  // autocomplete is space-separated tokens; check membership rather than a
  // strict word boundary, so values like "username webauthn" still match.
  const acTokens = autocompleteTokens(node);
  if (acTokens.includes("username") || acTokens.includes("email")) return true;
  if (t === "email") return true;

  const tokens = [
    node.name || "",
    node.id || "",
    node.getAttribute("aria-label") || "",
    node.getAttribute("aria-labelledby") || "",
    node.placeholder || "",
    labelText(node),
  ]
    .join(" ")
    .toLowerCase();

  return /\b(user(name)?|email|login|account|signin|identifier)\b/.test(tokens);
}

function isAutofillTarget(node: Element | null): node is HTMLInputElement {
  return isPasswordInput(node) || isUsernameLikeInput(node) || isOtpInput(node);
}

function suppressNativeAutocomplete(input: HTMLInputElement) {
  const orig = input.getAttribute("autocomplete");
  if (orig !== null && !input.hasAttribute(ATTR_ORIG_AUTOCOMPLETE)) {
    input.setAttribute(ATTR_ORIG_AUTOCOMPLETE, orig);
  }
  if (input.getAttribute("autocomplete") !== "off") {
    input.setAttribute("autocomplete", "off");
  }
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

// ---------- sign-up detection ----------

const SIGNUP_RE = /\b(sign ?up|register|registration|create (an |your |new )?account|join|enroll|new password)\b/;
const LOGIN_RE = /\b(sign ?in|log ?in|logon)\b/;

/** Lowercased words from attribute/text snippets: `signUpForm` / `sign_up` → `sign up form`. */
function normalizeWords(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => p || "")
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-/.]+/g, " ")
    .toLowerCase();
}

function passwordInputsIn(scope: ParentNode): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement>("input")).filter(isPasswordInput);
}

function isSubmitControl(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return el.type === "submit";
  if (el instanceof HTMLInputElement) return el.type === "submit" || el.type === "image";
  return false;
}

function controlText(el: Element): string {
  return normalizeWords(
    el.textContent,
    el instanceof HTMLInputElement ? el.value : "",
    el.getAttribute("aria-label"),
    el.id,
    el.getAttribute("name"),
  );
}

/**
 * Heuristic: does this password input take a *new* password (sign-up, or the
 * new/confirm pair on a change-password form)?
 *   - autocomplete=new-password wins; autocomplete=current-password loses;
 *   - two password inputs in the form → password + confirm;
 *   - three → current, new, confirm: everything but the first;
 *   - otherwise sign-up keywords on the field, the form, or its submit button,
 *     unless that button reads like a login.
 */
function isNewPasswordInput(node: Element | null): node is HTMLInputElement {
  if (!isPasswordInput(node)) return false;
  const ac = autocompleteTokens(node);
  if (ac.includes("new-password")) return true;
  if (ac.includes("current-password")) return false;

  const form = node.form;
  const all = passwordInputsIn(form ?? document);
  if (all.length >= 3) return all.indexOf(node) > 0;
  if (all.length === 2) return true;

  const submit = form
    ? Array.from(form.querySelectorAll("button, input[type=submit], input[type=image]")).find(isSubmitControl)
    : undefined;
  const submitText = submit ? controlText(submit) : "";
  if (LOGIN_RE.test(submitText) && !SIGNUP_RE.test(submitText)) return false;

  const context = normalizeWords(
    node.name,
    node.id,
    node.getAttribute("aria-label"),
    node.placeholder,
    form?.id,
    form?.getAttribute("name"),
    form?.getAttribute("action"),
    form?.getAttribute("aria-label"),
  );
  return SIGNUP_RE.test(context) || SIGNUP_RE.test(submitText);
}

/**
 * The inputs a generated password goes into: the focused field plus the other
 * new-password fields of its form (the confirm field), never a
 * current-password field.
 */
function newPasswordInputsFor(anchor: HTMLInputElement): HTMLInputElement[] {
  const others = passwordInputsIn(anchor.form ?? document).filter(
    (el) => el !== anchor && isNewPasswordInput(el),
  );
  return [anchor, ...others];
}

/** Best guess at the username/email field of a sign-up form. */
function findSignupUsernameInput(passwordInput: HTMLInputElement): HTMLInputElement | null {
  const inputs = Array.from((passwordInput.form ?? document).querySelectorAll<HTMLInputElement>("input")).filter(
    (el) => isCandidateInput(el) && el.type !== "password",
  );
  return (
    inputs.find((el) => autocompleteTokens(el).includes("username")) ??
    inputs.find((el) => autocompleteTokens(el).includes("email") || el.type === "email") ??
    inputs.find((el) => isUsernameLikeInput(el)) ??
    findUsernameInput(passwordInput)
  );
}

// ---------- shadow-DOM UI (Preact) ----------

const INDICATOR_CSS = `
  :host { all: initial; }
  .btn {
    width: 100%;
    height: 100%;
    border-radius: 5px;
    border: 0;
    background: none;
    cursor: pointer;
    display: block;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    transition: box-shadow 0.15s;
  }
  .btn:hover, .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px #dcb05a, 0 1px 4px rgba(0,0,0,0.3); }
  .mark { width: 100%; height: 100%; }
`;

const DROPDOWN_CSS = `
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
  .panel.loading {
    color: #9b9ba1;
    font-size: 12px;
    padding: 14px;
    text-align: center;
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
  .header .mark { width: 16px; height: 16px; }
  .header .brand {
    color: #f4ecdc;
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
  .gen {
    margin: 4px 4px 6px;
    padding: 10px;
    border: 1px solid #2e2e33;
    border-radius: 8px;
    background: #202023;
  }
  .gen-title { font-weight: 500; margin-bottom: 6px; }
  .gen-row { display: flex; align-items: center; gap: 6px; }
  .gen-pw {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #c7d2fe;
    background: #1a1a1c;
    border: 1px solid #2e2e33;
    border-radius: 6px;
    padding: 6px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    background: transparent;
    border: 1px solid #2e2e33;
    color: #9b9ba1;
    border-radius: 6px;
    padding: 5px 7px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .icon-btn:hover { color: #e8e8ea; background: #2c2c30; }
  .gen .action { width: 100%; margin: 8px 0 0; }
`;

const TOAST_CSS = `
  :host { all: initial; }
  .toast {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: #e8e8ea;
    background: #1a1a1c;
    border: 1px solid #2e2e33;
    border-left: 3px solid #10b981;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    padding: 10px 14px;
    max-width: 340px;
  }
  .toast.error { border-left-color: #f43f5e; }
  .toast .brand { color: #f4ecdc; font-weight: 600; margin-right: 6px; }
`;

function Indicator({ onActivate }: { onActivate: () => void }) {
  return (
    <>
      <style>{INDICATOR_CSS}</style>
      <button
        class="btn"
        type="button"
        aria-label="Open LocalPass"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onActivate();
        }}
      >
        <Logo small class="mark" />
      </button>
    </>
  );
}

function LoadingDropdown() {
  return (
    <>
      <style>{DROPDOWN_CSS}</style>
      <div class="panel loading">Loading…</div>
    </>
  );
}

function Item({
  entry,
  otpMode,
  onPick,
}: {
  entry: AutofillEntry;
  otpMode: boolean;
  onPick: (key: string) => void;
}) {
  return (
    <button
      class="item"
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick(entry.key);
      }}
    >
      <div class="avatar" style={`background: ${colorFor(entry.key)}`}>
        {initials(entry.key)}
      </div>
      <div class="meta">
        <div class="key">{entry.key}</div>
        <div class="user">{otpMode ? "Fill one-time code" : entry.username || "—"}</div>
      </div>
    </button>
  );
}

function OpenPopupButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      class="action"
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
    >
      {label}
    </button>
  );
}

/**
 * "Use generated password" section for sign-up fields. The password comes from
 * the background (one generator for every surface) and is sized to the field's
 * minlength/maxlength. Nothing is recorded until the user clicks "Use".
 */
function GeneratorSection({
  field,
  onUse,
}: {
  field: HTMLInputElement;
  onUse: (password: string) => void;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const generate = () => {
    setPassword(null);
    sendMessage<{ ok: false } | { ok: true; password: string }>("GENERATE_PASSWORD", {
      minLength: field.minLength,
      maxLength: field.maxLength,
    })
      .then((r) => setPassword(r.ok ? r.password : null))
      .catch(() => {});
  };
  useEffect(generate, [field]);

  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="gen">
      <div class="gen-title">Suggested strong password</div>
      <div class="gen-row">
        <div class="gen-pw">
          {password === null ? "…" : reveal ? password : "•".repeat(Math.min(password.length, 24))}
        </div>
        <button
          class="icon-btn"
          type="button"
          title={reveal ? "Hide" : "Show"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            stop(e);
            setReveal(!reveal);
          }}
        >
          {reveal ? "Hide" : "Show"}
        </button>
        <button
          class="icon-btn"
          type="button"
          title="Generate another"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            stop(e);
            generate();
          }}
        >
          ↻
        </button>
      </div>
      <button
        class="action"
        type="button"
        disabled={password === null}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          stop(e);
          if (password) onUse(password);
        }}
      >
        Use generated password
      </button>
    </div>
  );
}

function DropdownPanel({
  result,
  otpMode,
  signupField,
  onPick,
  onOpenPopup,
  onUseGenerated,
}: {
  result: QueryResult;
  otpMode: boolean;
  /** Set when the field takes a new password: show the generator. */
  signupField: HTMLInputElement | null;
  onPick: (key: string) => void;
  onOpenPopup: () => void;
  onUseGenerated: (password: string) => void;
}) {
  let body;
  if (result.state === "no_vault") {
    body = (
      <>
        <div class="empty">
          No vault yet.
          <br />
          Open LocalPass to set up.
        </div>
        <OpenPopupButton label="Open LocalPass" onOpen={onOpenPopup} />
      </>
    );
  } else if (result.state === "locked" && signupField) {
    body = (
      <>
        <div class="empty">
          <strong style="color:#e8e8ea">Vault is locked</strong>
          <br />
          Unlock LocalPass to use a generated password.
        </div>
        <OpenPopupButton label="Unlock LocalPass" onOpen={onOpenPopup} />
      </>
    );
  } else if (result.state === "locked") {
    body = (
      <>
        <div class="empty">
          <strong style="color:#e8e8ea">Vault is locked</strong>
          <br />
          Click below to unlock and autofill.
        </div>
        <OpenPopupButton label="Unlock LocalPass" onOpen={onOpenPopup} />
      </>
    );
  } else if (signupField) {
    // On a sign-up form an unrelated entry is rarely wanted; keep this site's
    // entries (the user may be changing a password) below the generator.
    body = (
      <>
        <GeneratorSection field={signupField} onUse={onUseGenerated} />
        {result.matches.length > 0 && (
          <>
            <div class="group-label">Saved for this site</div>
            {result.matches.map((e) => (
              <Item key={e.key} entry={e} otpMode={false} onPick={onPick} />
            ))}
          </>
        )}
      </>
    );
  } else {
    // On a one-time-code field only entries with a TOTP secret are useful.
    const matches = otpMode ? result.matches.filter((e) => e.hasOtp) : result.matches;
    const others = otpMode ? result.others.filter((e) => e.hasOtp) : result.others;
    if (matches.length + others.length === 0) {
      body = <div class="empty">{otpMode ? "No items with a one-time password." : "Vault is empty."}</div>;
    } else {
      body = (
        <>
          {matches.length > 0 && (
            <>
              <div class="group-label">Matches this site</div>
              {matches.map((e) => (
                <Item key={e.key} entry={e} otpMode={otpMode} onPick={onPick} />
              ))}
            </>
          )}
          {others.length > 0 && (
            <>
              <div class="group-label">{matches.length > 0 ? "Other items" : "All items"}</div>
              {others.map((e) => (
                <Item key={e.key} entry={e} otpMode={otpMode} onPick={onPick} />
              ))}
            </>
          )}
        </>
      );
    }
  }

  return (
    <>
      <style>{DROPDOWN_CSS}</style>
      <div class="panel">
        <div class="header">
          <Logo small class="mark" />
          <span class="brand">LocalPass</span>
          {otpMode && <span>One-time code</span>}
          {signupField && <span>New password</span>}
        </div>
        <div class="list">{body}</div>
      </div>
    </>
  );
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
  positionOverPasswordField(host, input);
  render(<Indicator onActivate={() => void openDropdown(input)} />, shadow);
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
    // make the user wait. Opening the dropdown is an explicit user action, so
    // this query resets the sliding auto-lock timer.
    refreshCache(true).catch(() => {});
    return;
  }

  showLoadingDropdown(input);
  try {
    const result = await refreshCache(true);
    if (activeField !== input) return;
    clearDropdown();
    showDropdown(input, result);
  } catch {
    if (activeField === input) clearDropdown();
  }
}

function positionDropdownHost(input: HTMLInputElement): HTMLElement {
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
  return host;
}

function showLoadingDropdown(input: HTMLInputElement) {
  const host = positionDropdownHost(input);
  const shadow = host.attachShadow({ mode: "closed" });
  render(<LoadingDropdown />, shadow);
  document.documentElement.appendChild(host);
  activeDropdown = host;
}

function showDropdown(input: HTMLInputElement, result: QueryResult) {
  const host = positionDropdownHost(input);
  const shadow = host.attachShadow({ mode: "closed" });
  const otpMode = isOtpInput(input);
  const signupField = isNewPasswordInput(input) ? input : null;
  render(
    <DropdownPanel
      result={result}
      otpMode={otpMode}
      signupField={signupField}
      onPick={(key) => {
        void (otpMode ? fillOtp(key) : fillEntry(key));
        clearDropdown();
      }}
      onOpenPopup={() => {
        void sendMessage("OPEN_POPUP", {});
        clearDropdown();
      }}
      onUseGenerated={(password) => {
        void fillGenerated(input, password);
        clearDropdown();
      }}
    />,
    shadow,
  );
  document.documentElement.appendChild(host);
  activeDropdown = host;

  // close on outside click / scroll / escape
  setTimeout(() => document.addEventListener("mousedown", onOutsideMouseDown, true), 0);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", clearDropdown, { passive: true, once: true });
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

async function fillOtp(key: string) {
  const field = activeField;
  if (!field) return;
  const res = await sendMessage<{ ok: false } | { ok: true; code: string }>("AUTOFILL_OTP", { key });
  if (res.ok) setNativeValue(field, res.code);
}

/**
 * Fill a generated password into the sign-up field and its confirm field,
 * record it as pending in the background, and watch the form for submit.
 */
async function fillGenerated(field: HTMLInputElement, password: string) {
  for (const f of newPasswordInputsFor(field)) setNativeValue(f, password);
  const username = findSignupUsernameInput(field)?.value.trim() ?? "";
  const res = await sendMessage<{ ok: boolean }>("GENERATED_PASSWORD_ACCEPT", { username, password });
  if (res.ok) watchSignupSubmit(field);
}

// ---------- save on submit ----------

let stopSignupWatch: (() => void) | null = null;

/**
 * Commit the pending generated password once the sign-up form is submitted.
 * Covers the form's `submit` event (fires after HTML validation passes, and for
 * Enter-to-submit), and — for sites that submit from script — clicks on a
 * sign-up-looking button that isn't a native submit control, or Enter in a
 * field when there's no <form>. All listeners are capture-phase on the
 * document so page handlers can't swallow them; the first one wins.
 */
function watchSignupSubmit(field: HTMLInputElement) {
  stopSignupWatch?.();
  const form = field.form;

  const inScope = (el: Element) => (form ? form.contains(el) : true);

  const onSubmit = (e: Event) => {
    if (!form || e.target === form) commit();
  };
  const onClick = (e: MouseEvent) => {
    const target = e.composedPath()[0];
    if (!(target instanceof Element)) return;
    const el = target.closest("button, input[type=submit], input[type=image], input[type=button], [role=button], a");
    if (!el || !inScope(el)) return;
    // Native submit controls in a form are covered by the submit event.
    if (form && isSubmitControl(el)) return;
    if (SIGNUP_RE.test(controlText(el))) commit();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (form || e.key !== "Enter") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && (t.type === "password" || t === findSignupUsernameInput(field))) {
      commit();
    }
  };

  const stop = () => {
    document.removeEventListener("submit", onSubmit, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    stopSignupWatch = null;
  };
  // Read the values at submit time: the user may have tweaked the password.
  const commit = () => {
    stop();
    const username = findSignupUsernameInput(field)?.value.trim() ?? "";
    void sendMessage("GENERATED_PASSWORD_SUBMIT", { username, password: field.value }).catch(() => {});
  };

  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  stopSignupWatch = stop;
}

// ---------- toast ----------

function showToast(kind: "success" | "error", text: string) {
  const host = document.createElement("localpass-toast");
  host.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: ${Z_BASE + 2};
  `;
  const shadow = host.attachShadow({ mode: "closed" });
  render(
    <>
      <style>{TOAST_CSS}</style>
      <div class={`toast ${kind === "error" ? "error" : ""}`} role="status">
        <span class="brand">LocalPass</span>
        {text}
      </div>
    </>,
    shadow,
  );
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), kind === "error" ? 6000 : 3500);
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

  // Suppress the native browser credential dropdown so it doesn't overlay our
  // suggestions. Firefox's dropdown is rendered by the browser chrome, so
  // z-index can't win — we have to opt out at the source. Stash the original
  // attribute in case site code reads it, but don't restore: autocomplete
  // doesn't affect form submission, only the browser UI we're suppressing.
  suppressNativeAutocomplete(input);

  const onFocus = () => {
    if (!isAutofillTarget(input)) return;
    if (!isVisibleEnough(input)) return;
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
  const msg = message as { type?: string; kind?: "success" | "error"; text?: string };
  if (msg?.type === "LOCALPASS_TOAST" && msg.text) {
    showToast(msg.kind ?? "success", msg.text);
    return;
  }
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

// Just-in-time fallback: if a framework injected an input we missed (no
// MutationObserver event, e.g. a re-parented element), hook it the moment the
// user actually focuses it. The hooked attr keeps this idempotent.
document.addEventListener(
  "focusin",
  (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.getAttribute(ATTR_HOOKED) === "1") return;
    if (!isAutofillTarget(target)) return;
    attachTo(target);
  },
  true,
);

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "attributes" && m.attributeName === "autocomplete") {
      const t = m.target;
      if (
        t instanceof HTMLInputElement &&
        t.getAttribute(ATTR_HOOKED) === "1" &&
        t.getAttribute("autocomplete") !== "off"
      ) {
        // Page code overwrote it — reapply.
        suppressNativeAutocomplete(t);
      }
      continue;
    }
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
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["autocomplete"],
});

window.addEventListener("resize", () => {
  if (activeIndicator && activeField) positionOverPasswordField(activeIndicator, activeField);
  if (activeDropdown) clearDropdown();
});
window.addEventListener("scroll", () => {
  if (activeIndicator && activeField) positionOverPasswordField(activeIndicator, activeField);
}, { passive: true });
