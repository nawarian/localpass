/**
 * LocalPass Options / Settings Page
 */

import type { Config } from "@localpass/core";
import { s3Download } from "@localpass/core/dist/s3.js";
import { loadStore } from "@localpass/core/dist/store.js";
import { listKeys } from "@localpass/core/dist/vault.js";

interface Settings {
  autoLockMinutes: number;
}

const SETTINGS_KEY = "localpass:settings";
const DEFAULT_AUTO_LOCK_MIN = 5;

let currentConfig: Config | null = null;

const $ = (id: string) => document.getElementById(id)!;

const s3Endpoint = $("s3-endpoint") as HTMLInputElement;
const s3Region = $("s3-region") as HTMLInputElement;
const s3Bucket = $("s3-bucket") as HTMLInputElement;
const s3Key = $("s3-key") as HTMLInputElement;
const awsAccessKeyId = $("aws-access-key-id") as HTMLInputElement;
const awsSecretAccessKey = $("aws-secret-access-key") as HTMLInputElement;
const s3Form = $("s3-form") as HTMLFormElement;
const statusMsg = $("status-message");
const pullBtn = $("pull-vault") as HTMLButtonElement;
const unlockSection = $("unlock-section") as HTMLElement;
const unlockForm = $("unlock-form") as HTMLFormElement;
const primaryPassword = $("primary-password") as HTMLInputElement;
const unlockStatus = $("unlock-status");
const vaultContent = $("vault-content") as HTMLElement;
const vaultSummary = $("vault-summary") as HTMLPreElement;

function setStatus(el: HTMLElement, msg: string, isError = false) {
  el.textContent = msg;
  el.className = `text-xs ${isError ? "text-red-400" : "text-emerald-400"}`;
}

function clearStatus(el: HTMLElement) {
  el.textContent = "";
  el.className = "text-xs";
}

function toConfig(): Config {
  return {
    s3_endpoint: s3Endpoint.value.trim(),
    s3_region: s3Region.value.trim(),
    s3_bucket: s3Bucket.value.trim(),
    s3_key: s3Key.value.trim(),
    aws_access_key_id: awsAccessKeyId.value.trim(),
    aws_secret_access_key: awsSecretAccessKey.value.trim(),
    auto_sync: false,
  };
}

function applyConfig(cfg: Config) {
  s3Endpoint.value = cfg.s3_endpoint;
  s3Region.value = cfg.s3_region;
  s3Bucket.value = cfg.s3_bucket;
  s3Key.value = cfg.s3_key;
  awsAccessKeyId.value = cfg.aws_access_key_id;
  awsSecretAccessKey.value = cfg.aws_secret_access_key;
}

async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  const min = stored?.autoLockMinutes;
  return {
    autoLockMinutes: typeof min === "number" && min > 0 ? min : DEFAULT_AUTO_LOCK_MIN,
  };
}

async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

const autoLockInput = $("auto-lock-minutes") as HTMLInputElement;
const securityForm = $("security-form") as HTMLFormElement;
const securityStatus = $("security-status");
const disableBrowserPmToggle = $("disable-browser-pm") as HTMLInputElement;
const browserPmStatus = $("browser-pm-status");
const allSitesToggle = $("all-sites-access") as HTMLInputElement;
const allSitesStatus = $("all-sites-status");

const ALL_URLS_PERMISSION = { origins: ["<all_urls>"] };

async function refreshAllSitesToggle() {
  if (!browser.permissions) {
    allSitesToggle.disabled = true;
    setStatus(allSitesStatus, "permissions API not available.", true);
    return;
  }
  try {
    const granted = await browser.permissions.contains(ALL_URLS_PERMISSION);
    allSitesToggle.checked = granted;
    clearStatus(allSitesStatus);
  } catch (err) {
    setStatus(allSitesStatus, `Failed to read permission: ${(err as Error).message}`, true);
  }
}

allSitesToggle.addEventListener("change", async () => {
  clearStatus(allSitesStatus);
  if (allSitesToggle.checked) {
    try {
      const granted = await browser.permissions.request(ALL_URLS_PERMISSION);
      if (!granted) {
        allSitesToggle.checked = false;
        setStatus(allSitesStatus, "Permission denied.", true);
        return;
      }
      // Clear the "we already asked" flag so future unlocks skip prompting
      // (since it's now granted) but also don't leave a stale "prompted" mark
      // if the user revokes and re-adds.
      await browser.storage.local.remove("localpass:sites_prompted");
      setStatus(allSitesStatus, "Granted access on all sites.");
    } catch (err) {
      allSitesToggle.checked = false;
      setStatus(allSitesStatus, `Failed: ${(err as Error).message}`, true);
    }
  } else {
    try {
      const removed = await browser.permissions.remove(ALL_URLS_PERMISSION);
      if (!removed) {
        // Some Firefox versions can't remove permissions declared in
        // host_permissions — they're considered "required."
        allSitesToggle.checked = true;
        setStatus(
          allSitesStatus,
          "Firefox won't let this be revoked from here. Toggle it off in about:addons → LocalPass → Permissions.",
          true,
        );
        return;
      }
      setStatus(allSitesStatus, "Revoked all-sites access.");
    } catch (err) {
      allSitesToggle.checked = true;
      setStatus(allSitesStatus, `Failed: ${(err as Error).message}`, true);
    }
  }
});

if (browser.permissions?.onAdded) {
  browser.permissions.onAdded.addListener(refreshAllSitesToggle);
}
if (browser.permissions?.onRemoved) {
  browser.permissions.onRemoved.addListener(refreshAllSitesToggle);
}

const passwordSavingPref = browser.privacy?.services?.passwordSavingEnabled;

async function refreshBrowserPmToggle() {
  if (!passwordSavingPref) {
    disableBrowserPmToggle.disabled = true;
    setStatus(browserPmStatus, "This Firefox version does not expose the privacy API.", true);
    return;
  }
  try {
    const result = await passwordSavingPref.get({});
    disableBrowserPmToggle.checked = result.value === false;
    if (result.levelOfControl === "controlled_by_other_extensions") {
      disableBrowserPmToggle.disabled = true;
      setStatus(browserPmStatus, "Another extension is controlling this setting.", true);
    } else if (result.levelOfControl === "not_controllable") {
      disableBrowserPmToggle.disabled = true;
      setStatus(browserPmStatus, "This setting is not controllable in your environment.", true);
    } else {
      disableBrowserPmToggle.disabled = false;
      clearStatus(browserPmStatus);
    }
  } catch (err) {
    setStatus(browserPmStatus, `Failed to read setting: ${(err as Error).message}`, true);
  }
}

disableBrowserPmToggle.addEventListener("change", async () => {
  if (!passwordSavingPref) return;
  clearStatus(browserPmStatus);
  try {
    if (disableBrowserPmToggle.checked) {
      await passwordSavingPref.set({ value: false });
      setStatus(browserPmStatus, "Firefox password manager disabled.");
    } else {
      await passwordSavingPref.clear({});
      setStatus(browserPmStatus, "Firefox password manager restored.");
    }
  } catch (err) {
    setStatus(browserPmStatus, `Failed to update: ${(err as Error).message}`, true);
    await refreshBrowserPmToggle();
  }
});

async function init() {
  const response = await browser.runtime.sendMessage({ type: "CONFIG_GET" });
  if (response) {
    currentConfig = response as Config;
    applyConfig(currentConfig);
  }
  const settings = await loadSettings();
  autoLockInput.value = String(settings.autoLockMinutes);
  await refreshBrowserPmToggle();
  await refreshAllSitesToggle();
}

init().catch(console.error);

securityForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(securityStatus);
  const min = Number(autoLockInput.value);
  if (!Number.isFinite(min) || min < 1) {
    setStatus(securityStatus, "Enter at least 1 minute.", true);
    return;
  }
  await saveSettings({ autoLockMinutes: Math.floor(min) });
  setStatus(securityStatus, "Saved.");
});

s3Form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(statusMsg);
  const cfg = toConfig();
  try {
    await browser.runtime.sendMessage({ type: "CONFIG_SET", payload: cfg });
    currentConfig = cfg;
    setStatus(statusMsg, "Configuration saved.");
  } catch (err) {
    setStatus(statusMsg, `Failed to save: ${(err as Error).message}`, true);
  }
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

let pulledBytesB64: string | null = null;

pullBtn.addEventListener("click", async () => {
  clearStatus(statusMsg);
  clearStatus(unlockStatus);
  vaultContent.classList.add("hidden");

  const cfg = currentConfig ?? toConfig();
  if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
    setStatus(statusMsg, "Please fill in all S3 fields first.", true);
    return;
  }

  pullBtn.disabled = true;
  pullBtn.textContent = "Pulling…";
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
    pulledBytesB64 = b64;
    await browser.runtime.sendMessage({ type: "VAULT_BYTES_SET", payload: { b64 } });
    setStatus(statusMsg, "Vault pulled from S3.");
    unlockSection.classList.remove("hidden");
  } catch (err) {
    setStatus(statusMsg, `Failed to pull: ${(err as Error).message}`, true);
  } finally {
    pullBtn.disabled = false;
    pullBtn.textContent = "Pull vault from S3";
  }
});

unlockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(unlockStatus);
  vaultContent.classList.add("hidden");

  const password = primaryPassword.value.trim();
  if (!password) {
    setStatus(unlockStatus, "Please enter a primary password.", true);
    return;
  }

  try {
    const b64 = pulledBytesB64 ??
      (await browser.runtime.sendMessage({ type: "VAULT_BYTES_GET" }) as string | null);
    if (!b64) {
      setStatus(unlockStatus, "No vault data. Pull from S3 first.", true);
      return;
    }
    const vault = await loadStore(base64ToBytes(b64), password);
    const keys = listKeys(vault);
    vaultSummary.textContent =
      `Version: ${vault.version}\n` +
      `Entries: ${keys.length}\n\n` +
      (keys.length > 0 ? `Keys:\n  ${keys.join("\n  ")}` : "(empty vault)");
    vaultContent.classList.remove("hidden");
    setStatus(unlockStatus, "Vault unlocked.");
  } catch (err) {
    const msg = (err as Error).message;
    if (/wrong primary password|WRONG_PASSWORD/i.test(msg)) {
      setStatus(unlockStatus, "Wrong primary password.", true);
    } else {
      setStatus(unlockStatus, `Failed to unlock: ${msg}`, true);
    }
  }
});
