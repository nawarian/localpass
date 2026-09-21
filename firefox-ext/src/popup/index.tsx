/**
 * LocalPass Popup — 1Password-inspired UI (Preact).
 *
 * Decryption happens here (popup is a stable page). The background only
 * stores config and encrypted bytes — service worker memory isn't reliable.
 */

import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Entry, Vault } from "@localpass/core";
import { loadStore } from "@localpass/core/dist/store.js";
import { addEntry, deleteEntry, getEntry, listKeys } from "@localpass/core/dist/vault.js";
import {
  allocCustomId,
  base64ToBytes,
  clearCachedVault,
  clearPopupUI,
  colorFor,
  determineInitialState,
  draftToEntry,
  ensureHttp,
  ensureNextCustomId,
  entryToDraft,
  initials,
  loadCachedVault,
  loadPopupUI,
  maybeRequestSitesPermission,
  newDraft,
  nextPaint,
  persistVault,
  pullAndDecrypt,
  pullFromS3,
  pushToS3,
  savePopupUI,
  saveCachedVault,
  send,
  touchVault,
  type EditDraft,
  type UIState,
} from "./lib";
import {
  IconAlert,
  IconCheck,
  IconCloud,
  IconCopy,
  IconEye,
  IconGear,
  IconKey,
  IconList,
  IconLoader,
  IconLock,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  Logo,
} from "./icons";

// ---------- imperative toast ----------
//
// A transient, self-contained notification appended to <body>. It doesn't
// interact with the Preact tree, so an imperative helper is the simplest match
// for the previous behavior.

function flashToast(text: string, error = false) {
  const t = document.createElement("div");
  t.className = `pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-xs font-medium shadow-lg z-50 ${
    error ? "bg-red-500 text-white" : "bg-emerald-500 text-white"
  }`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1300);
}

async function copyToClipboard(text: string, label: string) {
  touchVault(); // copying is an explicit interaction — keep the vault alive
  try {
    await navigator.clipboard.writeText(text);
    flashToast(`${label} copied`);
  } catch {
    flashToast("Copy failed", true);
  }
}

// ---------- sync status banner ----------
//
// Saving an entry takes a noticeable amount of time: encrypt the vault,
// stash the bytes in extension storage, then push to S3. We surface progress
// as a fixed top banner so the user knows what's happening even when the
// underlying view re-renders mid-flow (edit pane → detail pane).

type SyncPhase = "working" | "success" | "error";
interface SyncStatus {
  phase: SyncPhase;
  message: string;
}

function SyncBanner({ status }: { status: SyncStatus }) {
  const tone =
    status.phase === "success"
      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
      : status.phase === "error"
      ? "bg-red-500/15 border-red-500/40 text-red-300"
      : "bg-surface border-border text-text";
  return (
    <div
      class={`fixed top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-xs font-medium shadow-lg z-50 flex items-center gap-2 border max-w-[90%] ${tone}`}
    >
      {status.phase === "success" ? (
        <IconCheck class="w-3.5 h-3.5 flex-shrink-0" />
      ) : status.phase === "error" ? (
        <IconAlert class="w-3.5 h-3.5 flex-shrink-0" />
      ) : (
        <IconLoader class="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
      )}
      {status.message}
    </div>
  );
}

// ---------- shared UI ----------

function PrimaryButton(props: {
  label: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.onClick}
      class="bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
    >
      {props.label}
    </button>
  );
}

function HeaderSimple() {
  return (
    <div class="flex items-center gap-2 px-3 py-2.5 border-b border-border bg-surface">
      <Logo small class="w-6 h-6" />
      <div class="text-sm font-semibold">LocalPass</div>
      <button
        class="ml-auto text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2"
        title="Settings"
        onClick={() => browser.runtime.openOptionsPage()}
      >
        <IconGear class="w-4 h-4" />
      </button>
    </div>
  );
}

// ---------- empty states ----------

function NoConfig() {
  return (
    <div class="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <Logo class="w-14 h-14 mb-4" />
      <h1 class="text-base font-semibold mb-2">Welcome to LocalPass</h1>
      <p class="text-sm text-text-muted max-w-xs mb-5">
        Configure your S3 bucket and credentials to start syncing your encrypted vault.
      </p>
      <PrimaryButton label="Open settings" onClick={() => browser.runtime.openOptionsPage()} />
    </div>
  );
}

function NoVault({ onPulled }: { onPulled: () => void }) {
  const [pulling, setPulling] = useState(false);

  const pull = async () => {
    setPulling(true);
    const res = await pullFromS3();
    if (!res.ok) {
      flashToast(res.error || "Pull failed", true);
      setPulling(false);
      return;
    }
    onPulled();
  };

  return (
    <div class="flex-1 flex flex-col">
      <HeaderSimple />
      <div class="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div class="w-14 h-14 rounded-full bg-surface-2 flex items-center justify-center mb-4">
          <IconCloud class="w-7 h-7 text-text-muted" />
        </div>
        <h1 class="text-base font-semibold mb-2">No vault yet</h1>
        <p class="text-sm text-text-muted max-w-xs mb-5">
          Pull your encrypted vault from S3 to get started.
        </p>
        <PrimaryButton label={pulling ? "Pulling…" : "Pull from S3"} onClick={pull} disabled={pulling} />
        <button
          class="mt-3 text-xs text-text-muted hover:text-text underline"
          onClick={() => browser.runtime.openOptionsPage()}
        >
          Open settings
        </button>
      </div>
    </div>
  );
}

function Locked({
  initialPassword,
  onPasswordChange,
  onUnlock,
}: {
  initialPassword: string;
  onPasswordChange: (pw: string) => void;
  onUnlock: (vault: Vault, password: string) => void;
}) {
  const [password, setPassword] = useState(initialPassword);
  const [error, setError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updatePassword = (pw: string) => {
    setPassword(pw);
    onPasswordChange(pw);
  };

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError("");
    if (!password.trim()) {
      setError("Enter your primary password.");
      return;
    }
    setUnlocking(true);
    try {
      const b64 = await send<string | null>("VAULT_BYTES_GET");
      if (!b64) {
        setError("No vault data. Pull from S3 first.");
        setUnlocking(false);
        return;
      }
      const pw = password.trim();
      const vault = await loadStore(base64ToBytes(b64), pw);
      await saveCachedVault(vault, pw);
      await maybeRequestSitesPermission();
      onUnlock(vault, pw);
    } catch (err) {
      const msg = (err as Error).message;
      if (/wrong primary password|WRONG_PASSWORD/i.test(msg)) {
        setError("Wrong primary password.");
      } else {
        setError(msg);
      }
      setUnlocking(false);
      inputRef.current?.select();
    }
  };

  const refresh = async () => {
    setError("");
    setRefreshing(true);
    const res = await pullFromS3();
    setRefreshing(false);
    if (!res.ok) {
      setError(res.error || "Refresh failed.");
    } else {
      flashToast("Refreshed from S3");
    }
  };

  return (
    <div class="flex-1 flex flex-col">
      <HeaderSimple />
      <div class="flex-1 flex flex-col items-center justify-center p-8">
        <div class="w-14 h-14 rounded-full bg-surface-2 flex items-center justify-center mb-4">
          <IconLock class="w-7 h-7 text-text-muted" />
        </div>
        <h1 class="text-base font-semibold mb-1">Vault locked</h1>
        <p class="text-sm text-text-muted mb-5">Enter your primary password to unlock.</p>

        <form class="w-full max-w-xs flex flex-col gap-3" onSubmit={submit}>
          <input
            ref={inputRef}
            type="password"
            autocomplete="off"
            placeholder="Primary password"
            value={password}
            onInput={(e) => updatePassword((e.target as HTMLInputElement).value)}
            class="w-full bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2.5 text-sm placeholder:text-text-dim"
          />
          <div class="text-xs text-red-400 min-h-[1rem]">{error}</div>
          <PrimaryButton label={unlocking ? "Unlocking…" : "Unlock"} type="submit" disabled={unlocking} />
        </form>

        <button
          type="button"
          class="mt-3 text-xs text-text-muted hover:text-text underline"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? "Refreshing…" : "Refresh from S3"}
        </button>
      </div>
    </div>
  );
}

// ---------- unlocked: top bar ----------

function TopBar({
  searchQuery,
  onSearch,
  onLock,
}: {
  searchQuery: string;
  onSearch: (q: string) => void;
  onLock: () => void;
}) {
  return (
    <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
      <div class="flex-1 flex items-center gap-2 bg-surface-2 border border-border rounded-md px-2.5 py-1.5">
        <IconSearch class="w-4 h-4 text-text-muted" />
        <input
          type="search"
          placeholder="Search LocalPass"
          value={searchQuery}
          onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
          class="flex-1 bg-transparent outline-none text-sm placeholder:text-text-dim"
        />
      </div>
      <button
        class="text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2"
        title="Lock vault"
        onClick={onLock}
      >
        <IconLock class="w-4 h-4" />
      </button>
      <button
        class="text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2"
        title="Settings"
        onClick={() => browser.runtime.openOptionsPage()}
      >
        <IconGear class="w-4 h-4" />
      </button>
    </div>
  );
}

// ---------- detail field ----------

function DetailField({ label, value, secret }: { label: string; value: string; secret: boolean }) {
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : "•".repeat(Math.min(value.length, 14));
  return (
    <div class="px-3 py-2.5 flex items-center gap-3 group">
      <div class="flex-1 min-w-0">
        <div class="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">{label}</div>
        <div class="text-sm truncate font-mono">{shown}</div>
      </div>
      {secret && (
        <button
          class="text-text-muted hover:text-text p-1 rounded"
          title="Reveal"
          onClick={() => {
            touchVault();
            setRevealed((r) => !r);
          }}
        >
          <IconEye class="w-4 h-4" />
        </button>
      )}
      <button
        class="text-text-muted hover:text-text p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        title={`Copy ${label}`}
        onClick={() => copyToClipboard(value, label)}
      >
        <IconCopy class="w-4 h-4" />
      </button>
    </div>
  );
}

const STANDARD_KEYS = new Set(["username", "email", "password", "url", "website", "notes"]);

function DetailPane({
  vault,
  selectedKey,
  onEdit,
}: {
  vault: Vault;
  selectedKey: string | null;
  onEdit: () => void;
}) {
  const entry: Entry | undefined = selectedKey ? getEntry(vault, selectedKey) : undefined;

  if (!selectedKey || !entry) {
    return (
      <div class="flex-1 min-w-0 flex flex-col bg-bg">
        <div class="flex-1 flex flex-col items-center justify-center text-center p-6">
          <div class="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mb-3">
            <IconKey class="w-6 h-6 text-text-muted" />
          </div>
          <p class="text-sm text-text-muted">Select an item to view details</p>
        </div>
      </div>
    );
  }

  const meta = entry.metadata || {};
  const username = meta["username"] || meta["email"] || "";
  const password = meta["password"] || "";
  const website = meta["url"] || meta["website"] || "";
  const customFields = Object.entries(meta).filter(([k]) => !STANDARD_KEYS.has(k));

  const openAndFill = () => {
    if (website) browser.tabs.create({ url: ensureHttp(website) });
    if (password) void copyToClipboard(password, "Password");
  };

  return (
    <div class="flex-1 min-w-0 flex flex-col bg-bg">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <div
          class={`w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-semibold text-white ${colorFor(selectedKey)}`}
        >
          {initials(selectedKey)}
        </div>
        <span class="text-sm font-medium truncate max-w-[140px]">{selectedKey}</span>
        <span class="text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded-full border border-border">
          Personal
        </span>
        <button
          class="ml-auto text-text-muted hover:text-text p-1.5 rounded-md hover:bg-surface-2"
          title="Edit item"
          onClick={onEdit}
        >
          <IconPencil class="w-4 h-4" />
        </button>
        <button
          class="text-xs font-medium border border-accent/60 text-accent hover:bg-accent hover:text-white rounded-full px-3 py-1 transition-colors"
          onClick={openAndFill}
        >
          Open & Fill
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-3">
        <div class="flex items-center gap-3">
          <div
            class={`w-12 h-12 rounded-lg flex items-center justify-center text-base font-semibold text-white ${colorFor(selectedKey)}`}
          >
            {initials(selectedKey)}
          </div>
          <div class="min-w-0">
            <div class="text-lg font-semibold truncate">{selectedKey}</div>
          </div>
        </div>

        {(username || password || customFields.length > 0) && (
          <div class="rounded-lg bg-surface border border-border divide-y divide-border">
            {username && <DetailField label="username" value={username} secret={false} />}
            {password && <DetailField label="password" value={password} secret={true} />}
            {customFields.map(([k, v]) => (
              <DetailField key={k} label={k} value={v} secret={/pass|secret|token/i.test(k)} />
            ))}
          </div>
        )}

        {website && (
          <a
            href={ensureHttp(website)}
            target="_blank"
            rel="noopener noreferrer"
            class="block text-sm rounded-lg bg-surface border border-border px-3 py-2.5 hover:border-border-strong transition-colors"
          >
            <div class="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">website</div>
            <div class="text-accent truncate">{website}</div>
          </a>
        )}

        {meta["notes"] && (
          <div class="rounded-lg bg-surface border border-border px-3 py-2.5">
            <div class="text-[11px] uppercase tracking-wider text-text-muted mb-1">notes</div>
            <div class="text-sm whitespace-pre-wrap">{meta["notes"]}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- edit pane ----------

function EditInput({
  label,
  value,
  onInput,
  placeholder,
  secret,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
}) {
  return (
    <label class="block">
      <span class="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
      <input
        type={secret ? "password" : "text"}
        autocomplete="off"
        placeholder={placeholder ?? ""}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        class="mt-1 w-full bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2 text-sm placeholder:text-text-dim font-mono"
      />
    </label>
  );
}

function EditPane({
  draft,
  onChange,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: EditDraft;
  onChange: (next: EditDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const isNew = draft.originalKey === null;
  const patch = (p: Partial<EditDraft>) => onChange({ ...draft, ...p });

  return (
    <div class="flex-1 min-w-0 flex flex-col bg-bg">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <span class="text-sm font-medium">{isNew ? "New item" : "Edit item"}</span>
        <button
          class="ml-auto text-xs font-medium border border-border hover:border-border-strong rounded-full px-3 py-1 transition-colors"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          class="text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-full px-3 py-1 transition-colors"
          onClick={onSave}
        >
          Save
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-3">
        <EditInput label="Name" value={draft.key} onInput={(v) => patch({ key: v })} placeholder="e.g. github.com" />
        <EditInput label="Username" value={draft.username} onInput={(v) => patch({ username: v })} />
        <EditInput label="Password" value={draft.password} onInput={(v) => patch({ password: v })} secret />
        <EditInput
          label="Website"
          value={draft.website}
          onInput={(v) => patch({ website: v })}
          placeholder="https://example.com"
        />
        <label class="block">
          <span class="text-[11px] uppercase tracking-wider text-text-muted">Notes</span>
          <textarea
            rows={3}
            value={draft.notes}
            onInput={(e) => patch({ notes: (e.target as HTMLTextAreaElement).value })}
            class="mt-1 w-full bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2 text-sm placeholder:text-text-dim resize-y"
          />
        </label>

        <div class="rounded-lg bg-surface border border-border">
          <div class="px-3 py-2 flex items-center border-b border-border">
            <span class="text-[11px] uppercase tracking-wider text-text-muted">Custom fields</span>
            <button
              class="ml-auto text-xs text-accent hover:text-accent-hover"
              onClick={() =>
                patch({ custom: [...draft.custom, { id: allocCustomId(), name: "", value: "" }] })
              }
            >
              + Add field
            </button>
          </div>
          {draft.custom.length === 0 ? (
            <div class="px-3 py-3 text-xs text-text-dim">No custom fields.</div>
          ) : (
            draft.custom.map((f) => (
              <div
                key={f.id}
                class="px-3 py-2 flex items-center gap-2 border-b border-border last:border-b-0"
              >
                <input
                  type="text"
                  placeholder="field name"
                  value={f.name}
                  onInput={(e) =>
                    patch({
                      custom: draft.custom.map((c) =>
                        c.id === f.id ? { ...c, name: (e.target as HTMLInputElement).value } : c,
                      ),
                    })
                  }
                  class="w-32 bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded px-2 py-1 text-xs"
                />
                <input
                  type="text"
                  placeholder="value"
                  value={f.value}
                  onInput={(e) =>
                    patch({
                      custom: draft.custom.map((c) =>
                        c.id === f.id ? { ...c, value: (e.target as HTMLInputElement).value } : c,
                      ),
                    })
                  }
                  class="flex-1 min-w-0 bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded px-2 py-1 text-xs font-mono"
                />
                <button
                  class="text-text-muted hover:text-red-400 p-1 rounded"
                  title="Remove field"
                  onClick={() => patch({ custom: draft.custom.filter((c) => c.id !== f.id) })}
                >
                  <IconTrash class="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>

        {!isNew && (
          <div class="pt-2">
            <button
              class="w-full text-sm font-medium border border-red-500/40 text-red-400 hover:bg-red-500 hover:text-white rounded-lg px-3 py-2 transition-colors"
              onClick={onDelete}
            >
              Delete item
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- unlocked shell ----------

function Unlocked({
  vault,
  selectedKey,
  searchQuery,
  editDraft,
  onSearch,
  onLock,
  onSelect,
  onNew,
  onEdit,
  onDraftChange,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  vault: Vault;
  selectedKey: string | null;
  searchQuery: string;
  editDraft: EditDraft | null;
  onSearch: (q: string) => void;
  onLock: () => void;
  onSelect: (key: string) => void;
  onNew: () => void;
  onEdit: () => void;
  onDraftChange: (next: EditDraft) => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const keys = listKeys(vault);
  const filtered = keys.filter((k) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    if (k.toLowerCase().includes(q)) return true;
    const e = vault.entries[k];
    const username = e?.metadata?.["username"] || e?.metadata?.["email"] || "";
    return username.toLowerCase().includes(q);
  });

  return (
    <div class="flex-1 flex flex-col min-h-0">
      <TopBar searchQuery={searchQuery} onSearch={onSearch} onLock={onLock} />
      <div class="flex-1 flex min-h-0">
        <div class="w-[200px] border-r border-border bg-surface flex flex-col min-h-0">
          <div class="px-3 py-2.5 border-b border-border flex items-center gap-2 text-sm">
            <IconList class="w-4 h-4 text-text-muted" />
            <span class="font-medium">All Items</span>
            <span class="ml-2 text-xs text-text-dim">{keys.length}</span>
            <button
              class="ml-auto text-text-muted hover:text-text p-1 rounded hover:bg-surface-2"
              title="New item"
              onClick={onNew}
            >
              <IconPlus class="w-4 h-4" />
            </button>
          </div>
          <ul class="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li class="px-3 py-6 text-center text-xs text-text-dim">
                {searchQuery ? "No matches" : "Vault is empty"}
              </li>
            )}
            {filtered.map((key) => {
              const entry = vault.entries[key];
              const isSelected = key === selectedKey;
              const username = entry?.metadata?.["username"] || entry?.metadata?.["email"] || "";
              return (
                <li key={key}>
                  <button
                    class={`w-full text-left px-2.5 py-2 mx-1 my-0.5 rounded-md flex items-center gap-2.5 transition-colors ${
                      isSelected ? "bg-accent text-white" : "hover:bg-surface-2 text-text"
                    }`}
                    onClick={() => onSelect(key)}
                  >
                    <div
                      class={`w-8 h-8 rounded-md flex-shrink-0 flex items-center justify-center text-[11px] font-semibold text-white ${colorFor(key)}`}
                    >
                      {initials(key)}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{key}</div>
                      <div class={`text-xs truncate ${isSelected ? "text-white/80" : "text-text-muted"}`}>
                        {username || "—"}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {editDraft ? (
          <EditPane
            draft={editDraft}
            onChange={onDraftChange}
            onCancel={onCancelEdit}
            onSave={onSave}
            onDelete={onDelete}
          />
        ) : (
          <DetailPane vault={vault} selectedKey={selectedKey} onEdit={onEdit} />
        )}
      </div>
    </div>
  );
}

// ---------- app ----------

function App() {
  const [uiState, setUiState] = useState<UIState>("locked");
  const [vault, setVault] = useState<Vault | null>(null);
  const [primaryPassword, setPrimaryPassword] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [lockedPassword, setLockedPassword] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Gate first render until bootstrap has rehydrated the snapshot, so the
  // Locked/Unlocked components mount with restored state (their local useState
  // reads the prop only once, on mount) rather than the initial empty values.
  const [hydrated, setHydrated] = useState(false);

  const syncTimerRef = useRef<number | undefined>(undefined);
  const isSyncingRef = useRef(false);
  // Debounce handle for snapshot writes (so each keystroke doesn't spam writes).
  const uiWriteTimerRef = useRef<number | undefined>(undefined);

  const showSync = useCallback((phase: SyncPhase | null, message?: string) => {
    if (syncTimerRef.current !== undefined) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = undefined;
    }
    if (phase === null) {
      setSyncStatus(null);
      return;
    }
    setSyncStatus({ phase, message: message || "" });
    if (phase === "success") {
      syncTimerRef.current = window.setTimeout(() => setSyncStatus(null), 1600);
    } else if (phase === "error") {
      // Errors stay visible long enough to read, then disappear so they don't
      // get stuck if the next op succeeds without re-triggering the banner.
      syncTimerRef.current = window.setTimeout(() => setSyncStatus(null), 4500);
    }
  }, []);

  // Bootstrap: adopt a cached unlocked session if present, else figure out
  // which empty/locked state to show. Then rehydrate the transient UI snapshot
  // saved before the popup was last dismissed (search/selection/draft when
  // unlocked, the typed unlock password when locked). loadCachedVault() already
  // drops the snapshot when the session is expired/cleared, so a stale or
  // unsafe snapshot will simply not be there to restore.
  useEffect(() => {
    (async () => {
      const cached = await loadCachedVault();
      if (cached) {
        setVault(cached.vault);
        setPrimaryPassword(cached.primaryPassword);
        setUiState("unlocked");
        // Opening the popup is itself an interaction — extend the idle timer.
        touchVault();
        const snap = await loadPopupUI();
        if (snap) {
          setSearchQuery(snap.searchQuery);
          setSelectedKey(snap.selectedKey);
          if (snap.editDraft) {
            ensureNextCustomId(snap.nextCustomId);
            setEditDraft(snap.editDraft);
          }
        }
        setHydrated(true);
        return;
      }
      const state = await determineInitialState();
      setUiState(state);
      if (state === "locked") {
        const snap = await loadPopupUI();
        if (snap?.lockedPassword) setLockedPassword(snap.lockedPassword);
      }
      setHydrated(true);
    })().catch((e) => setBootError((e as Error).message));
  }, []);

  // Persist the transient UI state to session storage on change, debounced so
  // each keystroke doesn't spam writes. Background's storage.onChanged listener
  // filters on the vault key, so this never triggers an autofill push.
  useEffect(() => {
    if (!hydrated) return;
    if (uiState !== "unlocked" && uiState !== "locked") return;
    if (uiWriteTimerRef.current !== undefined) clearTimeout(uiWriteTimerRef.current);
    uiWriteTimerRef.current = window.setTimeout(() => {
      void savePopupUI({
        searchQuery,
        selectedKey,
        editDraft,
        nextCustomId: editDraft
          ? editDraft.custom.reduce((m, c) => Math.max(m, c.id + 1), 1)
          : 1,
        lockedPassword: uiState === "locked" ? lockedPassword : "",
      });
    }, 250);
    return () => {
      if (uiWriteTimerRef.current !== undefined) clearTimeout(uiWriteTimerRef.current);
    };
  }, [hydrated, uiState, searchQuery, selectedKey, editDraft, lockedPassword]);

  const onUnlock = useCallback((v: Vault, password: string) => {
    setVault(v);
    setPrimaryPassword(password);
    setSelectedKey(null);
    setEditDraft(null);
    setSearchQuery("");
    // Unlock succeeded — drop the typed primary password from both state and
    // any snapshot written while locked. The unlocked-state effect re-saves a
    // fresh (passwordless) snapshot.
    setLockedPassword("");
    void clearPopupUI();
    setUiState("unlocked");
  }, []);

  const onLock = useCallback(async () => {
    setVault(null);
    setPrimaryPassword(null);
    setSelectedKey(null);
    setSearchQuery("");
    setEditDraft(null);
    setLockedPassword("");
    // clearCachedVault() also clears the UI snapshot (draft + any password).
    await clearCachedVault();
    setUiState(await determineInitialState());
  }, []);

  const reevaluate = useCallback(async () => {
    setUiState(await determineInitialState());
  }, []);

  const selectKey = useCallback(
    (key: string) => {
      if (editDraft && !confirm("Discard unsaved changes?")) return;
      touchVault(); // selecting/opening an entry is a genuine interaction
      setSelectedKey(key);
      setEditDraft(null);
    },
    [editDraft],
  );

  const onSearch = useCallback((q: string) => {
    touchVault(); // typing in search keeps the vault alive (throttled)
    setSearchQuery(q);
  }, []);

  const saveDraft = useCallback(async () => {
    if (isSyncingRef.current) return;
    if (!editDraft || !vault || !primaryPassword) return;
    const trimmedKey = editDraft.key.trim();
    if (!trimmedKey) {
      flashToast("Name is required", true);
      return;
    }
    const isRename = editDraft.originalKey !== null && editDraft.originalKey !== trimmedKey;
    const isNew = editDraft.originalKey === null;

    isSyncingRef.current = true;
    try {
      showSync("working", "Refreshing from S3…");
      await nextPaint();
      const refreshed = await pullAndDecrypt(primaryPassword);
      if (!refreshed.ok) {
        showSync("error", `Refresh failed: ${refreshed.error}`);
        return;
      }
      const v = refreshed.vault;

      if ((isNew || isRename) && v.entries[trimmedKey]) {
        showSync("error", `Item "${trimmedKey}" already exists`);
        return;
      }

      const entry = draftToEntry(editDraft, editDraft.createdAt);
      if (isRename && editDraft.originalKey) {
        deleteEntry(v, editDraft.originalKey);
      }
      addEntry(v, trimmedKey, entry);
      setVault(v);

      showSync("working", "Encrypting vault…");
      await nextPaint();
      const persistRes = await persistVault(v, primaryPassword);
      if (!persistRes.ok) {
        showSync("error", persistRes.error);
        return;
      }

      setSelectedKey(trimmedKey);
      setEditDraft(null);

      showSync("working", "Syncing to S3…");
      await nextPaint();
      const pushRes = await pushToS3();
      if (!pushRes.ok) {
        showSync("error", `S3 sync failed: ${pushRes.error}`);
        return;
      }
      showSync("success", "Saved & synced");
    } finally {
      isSyncingRef.current = false;
    }
  }, [editDraft, vault, primaryPassword, showSync]);

  const deleteSelected = useCallback(async () => {
    if (isSyncingRef.current) return;
    if (!vault || !selectedKey || !primaryPassword) return;
    const key = selectedKey;
    if (!confirm(`Delete "${key}"? This cannot be undone.`)) return;

    isSyncingRef.current = true;
    try {
      showSync("working", "Refreshing from S3…");
      await nextPaint();
      const refreshed = await pullAndDecrypt(primaryPassword);
      if (!refreshed.ok) {
        showSync("error", `Refresh failed: ${refreshed.error}`);
        return;
      }
      const v = refreshed.vault;

      if (!v.entries[key]) {
        setVault(v);
        setSelectedKey(null);
        setEditDraft(null);
        showSync("success", `"${key}" was already removed elsewhere`);
        return;
      }
      deleteEntry(v, key);
      setVault(v);

      showSync("working", "Encrypting vault…");
      await nextPaint();
      const persistRes = await persistVault(v, primaryPassword);
      if (!persistRes.ok) {
        showSync("error", persistRes.error);
        return;
      }

      setSelectedKey(null);
      setEditDraft(null);

      showSync("working", "Syncing to S3…");
      await nextPaint();
      const pushRes = await pushToS3();
      if (!pushRes.ok) {
        showSync("error", `S3 sync failed: ${pushRes.error}`);
        return;
      }
      showSync("success", "Deleted & synced");
    } finally {
      isSyncingRef.current = false;
    }
  }, [vault, selectedKey, primaryPassword, showSync]);

  const startEdit = useCallback(() => {
    if (!vault || !selectedKey) return;
    const e = getEntry(vault, selectedKey);
    if (!e) return;
    setEditDraft(entryToDraft(selectedKey, e));
  }, [vault, selectedKey]);

  let content;
  if (bootError) {
    content = <div class="p-6 text-sm text-red-400">Error: {bootError}</div>;
  } else if (!hydrated) {
    // Hold the first paint until the snapshot is rehydrated so Locked/Unlocked
    // mount with restored state rather than initial empty values.
    content = <div class="flex-1" />;
  } else if (uiState === "no_config") {
    content = <NoConfig />;
  } else if (uiState === "no_vault") {
    content = <NoVault onPulled={reevaluate} />;
  } else if (uiState === "locked") {
    content = (
      <Locked
        initialPassword={lockedPassword}
        onPasswordChange={setLockedPassword}
        onUnlock={onUnlock}
      />
    );
  } else if (vault) {
    content = (
      <Unlocked
        vault={vault}
        selectedKey={selectedKey}
        searchQuery={searchQuery}
        editDraft={editDraft}
        onSearch={onSearch}
        onLock={onLock}
        onSelect={selectKey}
        onNew={() => {
          setSelectedKey(null);
          setEditDraft(newDraft());
        }}
        onEdit={startEdit}
        onDraftChange={setEditDraft}
        onCancelEdit={() => setEditDraft(null)}
        onSave={saveDraft}
        onDelete={deleteSelected}
      />
    );
  }

  return (
    <>
      {content}
      {syncStatus && <SyncBanner status={syncStatus} />}
    </>
  );
}

const root = document.getElementById("app")!;
render(<App />, root);
