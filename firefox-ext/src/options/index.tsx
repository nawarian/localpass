/**
 * LocalPass Options / Settings Page (Preact).
 *
 * Same `browser.runtime.sendMessage` protocol and permissions/privacy logic as
 * before — only the DOM wiring is now declarative.
 */

import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Config } from "@localpass/core";
import { s3Download } from "@localpass/core/dist/s3.js";
import { loadStore } from "@localpass/core/dist/store.js";
import { listKeys } from "@localpass/core/dist/vault.js";
import { Logo } from "../popup/icons";

interface Settings {
  autoLockMinutes: number;
}

const SETTINGS_KEY = "localpass:settings";
const DEFAULT_AUTO_LOCK_MIN = 5;
const ALL_URLS_PERMISSION = { origins: ["<all_urls>"] };

interface StatusState {
  msg: string;
  isError: boolean;
}

function Status({ status, class: cls }: { status: StatusState | null; class?: string }) {
  const color = status ? (status.isError ? "text-red-400" : "text-emerald-400") : "";
  return <div class={`text-xs ${cls ?? ""} ${color}`}>{status?.msg ?? ""}</div>;
}

const emptyConfig = (): Config => ({
  s3_endpoint: "",
  s3_region: "",
  s3_bucket: "",
  s3_key: "",
  aws_access_key_id: "",
  aws_secret_access_key: "",
  auto_sync: false,
});

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

// Sliding auto-lock: configuring while the vault is unlocked should keep it
// alive. We tell the background to bump expiresAt on any genuine interaction
// with the page (typing, focusing a field, flipping a toggle). Throttled so a
// burst of keystrokes only sends one message every few seconds; the background
// never resurrects an already-expired vault, so this is safe even when locked.
const TOUCH_THROTTLE_MS = 3_000;
let lastTouchAt = 0;

function touchVault(): void {
  const now = Date.now();
  if (now - lastTouchAt < TOUCH_THROTTLE_MS) return;
  lastTouchAt = now;
  void browser.runtime.sendMessage({ type: "VAULT_TOUCH" }).catch(() => {
    /* background unavailable — expiry just won't extend this once */
  });
}

async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  const min = stored?.autoLockMinutes;
  return {
    autoLockMinutes: typeof min === "number" && min > 0 ? min : DEFAULT_AUTO_LOCK_MIN,
  };
}

const inputClass =
  "mt-1 w-full bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2 text-sm placeholder:text-text-dim";

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class="relative inline-flex items-center cursor-pointer mt-0.5">
      <input
        type="checkbox"
        class="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="w-9 h-5 bg-surface-3 rounded-full transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40"></span>
      <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></span>
    </label>
  );
}

function Options() {
  const [config, setConfig] = useState<Config>(emptyConfig());
  const currentConfigRef = useRef<Config | null>(null);
  const [s3Status, setS3Status] = useState<StatusState | null>(null);
  const [pulling, setPulling] = useState(false);
  const pulledBytesRef = useRef<string | null>(null);

  const [autoLock, setAutoLock] = useState(String(DEFAULT_AUTO_LOCK_MIN));
  const [securityStatus, setSecurityStatus] = useState<StatusState | null>(null);

  const [allSitesChecked, setAllSitesChecked] = useState(false);
  const [allSitesDisabled, setAllSitesDisabled] = useState(false);
  const [allSitesStatus, setAllSitesStatus] = useState<StatusState | null>(null);

  const [browserPmChecked, setBrowserPmChecked] = useState(false);
  const [browserPmDisabled, setBrowserPmDisabled] = useState(false);
  const [browserPmStatus, setBrowserPmStatus] = useState<StatusState | null>(null);

  const [unlockVisible, setUnlockVisible] = useState(false);
  const [primaryPassword, setPrimaryPassword] = useState("");
  const [unlockStatus, setUnlockStatus] = useState<StatusState | null>(null);
  const [vaultSummary, setVaultSummary] = useState<string | null>(null);

  const passwordSavingPref = browser.privacy?.services?.passwordSavingEnabled;

  const refreshAllSitesToggle = async () => {
    if (!browser.permissions) {
      setAllSitesDisabled(true);
      setAllSitesStatus({ msg: "permissions API not available.", isError: true });
      return;
    }
    try {
      const granted = await browser.permissions.contains(ALL_URLS_PERMISSION);
      setAllSitesChecked(granted);
      setAllSitesStatus(null);
    } catch (err) {
      setAllSitesStatus({ msg: `Failed to read permission: ${(err as Error).message}`, isError: true });
    }
  };

  const refreshBrowserPmToggle = async () => {
    if (!passwordSavingPref) {
      setBrowserPmDisabled(true);
      setBrowserPmStatus({ msg: "This Firefox version does not expose the privacy API.", isError: true });
      return;
    }
    try {
      const result = await passwordSavingPref.get({});
      setBrowserPmChecked(result.value === false);
      if (result.levelOfControl === "controlled_by_other_extensions") {
        setBrowserPmDisabled(true);
        setBrowserPmStatus({ msg: "Another extension is controlling this setting.", isError: true });
      } else if (result.levelOfControl === "not_controllable") {
        setBrowserPmDisabled(true);
        setBrowserPmStatus({ msg: "This setting is not controllable in your environment.", isError: true });
      } else {
        setBrowserPmDisabled(false);
        setBrowserPmStatus(null);
      }
    } catch (err) {
      setBrowserPmStatus({ msg: `Failed to read setting: ${(err as Error).message}`, isError: true });
    }
  };

  useEffect(() => {
    (async () => {
      const response = await browser.runtime.sendMessage({ type: "CONFIG_GET" });
      if (response) {
        currentConfigRef.current = response as Config;
        setConfig(response as Config);
      }
      const settings = await loadSettings();
      setAutoLock(String(settings.autoLockMinutes));
      await refreshBrowserPmToggle();
      await refreshAllSitesToggle();
    })().catch(console.error);

    if (browser.permissions?.onAdded) browser.permissions.onAdded.addListener(refreshAllSitesToggle);
    if (browser.permissions?.onRemoved) browser.permissions.onRemoved.addListener(refreshAllSitesToggle);

    // Keep the vault alive while the user is actively configuring. `input`
    // covers typing in fields, `change` covers toggles, `focusin` covers
    // tabbing between fields — all genuine interactions.
    const onInteract = () => touchVault();
    document.addEventListener("input", onInteract);
    document.addEventListener("change", onInteract);
    document.addEventListener("focusin", onInteract);

    return () => {
      if (browser.permissions?.onAdded) browser.permissions.onAdded.removeListener(refreshAllSitesToggle);
      if (browser.permissions?.onRemoved) browser.permissions.onRemoved.removeListener(refreshAllSitesToggle);
      document.removeEventListener("input", onInteract);
      document.removeEventListener("change", onInteract);
      document.removeEventListener("focusin", onInteract);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<Config>) => setConfig((c) => ({ ...c, ...p }));

  const saveConfig = async (e: Event) => {
    e.preventDefault();
    setS3Status(null);
    const cfg: Config = {
      s3_endpoint: config.s3_endpoint.trim(),
      s3_region: config.s3_region.trim(),
      s3_bucket: config.s3_bucket.trim(),
      s3_key: config.s3_key.trim(),
      aws_access_key_id: config.aws_access_key_id.trim(),
      aws_secret_access_key: config.aws_secret_access_key.trim(),
      auto_sync: false,
    };
    try {
      await browser.runtime.sendMessage({ type: "CONFIG_SET", payload: cfg });
      currentConfigRef.current = cfg;
      setS3Status({ msg: "Configuration saved.", isError: false });
    } catch (err) {
      setS3Status({ msg: `Failed to save: ${(err as Error).message}`, isError: true });
    }
  };

  const pullVault = async () => {
    setS3Status(null);
    setUnlockStatus(null);
    setVaultSummary(null);

    const cfg: Config = currentConfigRef.current ?? {
      s3_endpoint: config.s3_endpoint.trim(),
      s3_region: config.s3_region.trim(),
      s3_bucket: config.s3_bucket.trim(),
      s3_key: config.s3_key.trim(),
      aws_access_key_id: config.aws_access_key_id.trim(),
      aws_secret_access_key: config.aws_secret_access_key.trim(),
      auto_sync: false,
    };
    if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
      setS3Status({ msg: "Please fill in all S3 fields first.", isError: true });
      return;
    }

    setPulling(true);
    try {
      const data = await s3Download({
        endpoint: cfg.s3_endpoint || undefined,
        region: cfg.s3_region || "us-east-1",
        bucket: cfg.s3_bucket,
        key: cfg.s3_key,
        accessKeyId: cfg.aws_access_key_id,
        secretAccessKey: cfg.aws_secret_access_key,
      });
      const b64 = bytesToBase64(data);
      pulledBytesRef.current = b64;
      await browser.runtime.sendMessage({ type: "VAULT_BYTES_SET", payload: { b64 } });
      setS3Status({ msg: "Vault pulled from S3.", isError: false });
      setUnlockVisible(true);
    } catch (err) {
      setS3Status({ msg: `Failed to pull: ${(err as Error).message}`, isError: true });
    } finally {
      setPulling(false);
    }
  };

  const saveSecurity = async (e: Event) => {
    e.preventDefault();
    setSecurityStatus(null);
    const min = Number(autoLock);
    if (!Number.isFinite(min) || min < 1) {
      setSecurityStatus({ msg: "Enter at least 1 minute.", isError: true });
      return;
    }
    await browser.storage.local.set({ [SETTINGS_KEY]: { autoLockMinutes: Math.floor(min) } });
    setSecurityStatus({ msg: "Saved.", isError: false });
  };

  const onAllSitesChange = async (next: boolean) => {
    setAllSitesStatus(null);
    if (next) {
      try {
        const granted = await browser.permissions.request(ALL_URLS_PERMISSION);
        if (!granted) {
          setAllSitesChecked(false);
          setAllSitesStatus({ msg: "Permission denied.", isError: true });
          return;
        }
        // Clear the "we already asked" flag so future unlocks skip prompting
        // (since it's now granted) but also don't leave a stale "prompted" mark
        // if the user revokes and re-adds.
        await browser.storage.local.remove("localpass:sites_prompted");
        setAllSitesChecked(true);
        setAllSitesStatus({ msg: "Granted access on all sites.", isError: false });
      } catch (err) {
        setAllSitesChecked(false);
        setAllSitesStatus({ msg: `Failed: ${(err as Error).message}`, isError: true });
      }
    } else {
      try {
        const removed = await browser.permissions.remove(ALL_URLS_PERMISSION);
        if (!removed) {
          // Some Firefox versions can't remove permissions declared in
          // host_permissions — they're considered "required."
          setAllSitesChecked(true);
          setAllSitesStatus({
            msg: "Firefox won't let this be revoked from here. Toggle it off in about:addons → LocalPass → Permissions.",
            isError: true,
          });
          return;
        }
        setAllSitesChecked(false);
        setAllSitesStatus({ msg: "Revoked all-sites access.", isError: false });
      } catch (err) {
        setAllSitesChecked(true);
        setAllSitesStatus({ msg: `Failed: ${(err as Error).message}`, isError: true });
      }
    }
  };

  const onBrowserPmChange = async (next: boolean) => {
    if (!passwordSavingPref) return;
    setBrowserPmStatus(null);
    setBrowserPmChecked(next);
    try {
      if (next) {
        await passwordSavingPref.set({ value: false });
        setBrowserPmStatus({ msg: "Firefox password manager disabled.", isError: false });
      } else {
        await passwordSavingPref.clear({});
        setBrowserPmStatus({ msg: "Firefox password manager restored.", isError: false });
      }
    } catch (err) {
      setBrowserPmStatus({ msg: `Failed to update: ${(err as Error).message}`, isError: true });
      await refreshBrowserPmToggle();
    }
  };

  const unlock = async (e: Event) => {
    e.preventDefault();
    setUnlockStatus(null);
    setVaultSummary(null);

    const password = primaryPassword.trim();
    if (!password) {
      setUnlockStatus({ msg: "Please enter a primary password.", isError: true });
      return;
    }

    try {
      const b64 =
        pulledBytesRef.current ??
        ((await browser.runtime.sendMessage({ type: "VAULT_BYTES_GET" })) as string | null);
      if (!b64) {
        setUnlockStatus({ msg: "No vault data. Pull from S3 first.", isError: true });
        return;
      }
      const vault = await loadStore(base64ToBytes(b64), password);
      const keys = listKeys(vault);
      setVaultSummary(
        `Version: ${vault.version}\n` +
          `Entries: ${keys.length}\n\n` +
          (keys.length > 0 ? `Keys:\n  ${keys.join("\n  ")}` : "(empty vault)"),
      );
      setUnlockStatus({ msg: "Vault unlocked.", isError: false });
    } catch (err) {
      const msg = (err as Error).message;
      if (/wrong primary password|WRONG_PASSWORD/i.test(msg)) {
        setUnlockStatus({ msg: "Wrong primary password.", isError: true });
      } else {
        setUnlockStatus({ msg: `Failed to unlock: ${msg}`, isError: true });
      }
    }
  };

  return (
    <main class="max-w-2xl mx-auto px-6 py-10">
      <header class="flex items-center gap-3 mb-8">
        <Logo class="w-10 h-10 shadow-lg shadow-black/40 rounded-xl" />
        <div>
          <h1 class="text-xl font-semibold leading-tight">LocalPass</h1>
          <p class="text-xs text-text-muted">Settings</p>
        </div>
      </header>

      <section class="rounded-xl bg-surface border border-border p-5 mb-5">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-sm font-semibold">S3 Connection</h2>
          <span class="text-[10px] uppercase tracking-wider text-text-dim">Encrypted at rest</span>
        </div>
        <p class="text-xs text-text-muted mb-5">Where your encrypted vault is stored.</p>

        <form class="space-y-4" onSubmit={saveConfig}>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">S3 Endpoint</span>
              <input
                type="text"
                placeholder="https://s3.example.com"
                value={config.s3_endpoint}
                onInput={(e) => patch({ s3_endpoint: (e.target as HTMLInputElement).value })}
                class={inputClass}
              />
            </label>
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Region</span>
              <input
                type="text"
                placeholder="us-east-1"
                value={config.s3_region}
                onInput={(e) => patch({ s3_region: (e.target as HTMLInputElement).value })}
                class={inputClass}
              />
            </label>
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Bucket</span>
              <input
                type="text"
                placeholder="my-vault-bucket"
                value={config.s3_bucket}
                onInput={(e) => patch({ s3_bucket: (e.target as HTMLInputElement).value })}
                class={inputClass}
              />
            </label>
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Object key</span>
              <input
                type="text"
                placeholder="localpass/store.json"
                value={config.s3_key}
                onInput={(e) => patch({ s3_key: (e.target as HTMLInputElement).value })}
                class={inputClass}
              />
            </label>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Access Key ID</span>
              <input
                type="text"
                autocomplete="off"
                value={config.aws_access_key_id}
                onInput={(e) => patch({ aws_access_key_id: (e.target as HTMLInputElement).value })}
                class={`${inputClass} font-mono`}
              />
            </label>
            <label class="block">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Secret Access Key</span>
              <input
                type="password"
                autocomplete="off"
                value={config.aws_secret_access_key}
                onInput={(e) => patch({ aws_secret_access_key: (e.target as HTMLInputElement).value })}
                class={`${inputClass} font-mono`}
              />
            </label>
          </div>

          <div class="flex items-center gap-2 pt-2">
            <button
              type="submit"
              class="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Save configuration
            </button>
            <button
              type="button"
              onClick={pullVault}
              disabled={pulling}
              class="border border-border hover:border-border-strong text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              {pulling ? "Pulling…" : "Pull vault from S3"}
            </button>
            <Status status={s3Status} class="ml-2" />
          </div>
        </form>
      </section>

      <section class="rounded-xl bg-surface border border-border p-5 mb-5">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-sm font-semibold">Security</h2>
        </div>
        <p class="text-xs text-text-muted mb-5">Control how long the popup keeps your vault unlocked.</p>

        <form class="flex items-end gap-3" onSubmit={saveSecurity}>
          <label class="block">
            <span class="text-[11px] uppercase tracking-wider text-text-muted">Auto-lock after</span>
            <div class="mt-1 flex items-center gap-2">
              <input
                type="number"
                min="1"
                step="1"
                value={autoLock}
                onInput={(e) => setAutoLock((e.target as HTMLInputElement).value)}
                class="w-24 bg-surface-2 border border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 rounded-lg px-3 py-2 text-sm placeholder:text-text-dim"
              />
              <span class="text-sm text-text-muted">minutes</span>
            </div>
          </label>
          <button
            type="submit"
            class="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Save
          </button>
          <Status status={securityStatus} class="ml-2" />
        </form>

        <div class="mt-6 pt-5 border-t border-border">
          <div class="flex items-start gap-3">
            <Toggle checked={allSitesChecked} disabled={allSitesDisabled} onChange={onAllSitesChange} />
            <div class="flex-1">
              <div class="text-sm font-medium">Access data on all websites</div>
              <p class="text-xs text-text-muted mt-1">
                Required for the in-page autofill dropdown to appear on login forms. Without it, LocalPass
                needs to be granted access on each site individually from the toolbar icon.
              </p>
              <Status status={allSitesStatus} class="mt-2" />
            </div>
          </div>
        </div>

        <div class="mt-6 pt-5 border-t border-border">
          <div class="flex items-start gap-3">
            <Toggle checked={browserPmChecked} disabled={browserPmDisabled} onChange={onBrowserPmChange} />
            <div class="flex-1">
              <div class="text-sm font-medium">Disable Firefox's built-in password manager</div>
              <p class="text-xs text-text-muted mt-1">
                Suppresses the "Save password?" prompt and the native autocomplete dropdown so LocalPass stays
                out of the way. This flips a profile-wide Firefox preference; turning it off here restores the
                default.
              </p>
              <Status status={browserPmStatus} class="mt-2" />
            </div>
          </div>
        </div>
      </section>

      {unlockVisible && (
        <section class="rounded-xl bg-surface border border-border p-5">
          <h2 class="text-sm font-semibold mb-1">Unlock vault</h2>
          <p class="text-xs text-text-muted mb-4">
            Vault file pulled. Enter your primary password to verify.
          </p>
          <form class="flex items-end gap-2" onSubmit={unlock}>
            <label class="block flex-1">
              <span class="text-[11px] uppercase tracking-wider text-text-muted">Primary password</span>
              <input
                type="password"
                autocomplete="off"
                value={primaryPassword}
                onInput={(e) => setPrimaryPassword((e.target as HTMLInputElement).value)}
                class={inputClass}
              />
            </label>
            <button
              type="submit"
              class="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Unlock
            </button>
          </form>
          <Status status={unlockStatus} class="mt-3" />
          {vaultSummary !== null && (
            <div class="mt-4">
              <div class="text-xs text-text-muted mb-1">Vault summary</div>
              <pre class="text-xs bg-surface-2 border border-border rounded-lg p-3 overflow-auto">
                {vaultSummary}
              </pre>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

const root = document.getElementById("app")!;
render(<Options />, root);
