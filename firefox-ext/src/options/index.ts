/**
 * LocalPass Options / Settings Page
 *
 * Provides:
 *   - S3 connection configuration
 *   - Pull vault from S3
 *   - Unlock vault with master password
 */

import type { Config, Vault, Entry } from "@localpass/core";
import { s3Download, loadStore, listKeys } from "@localpass/core";

// --- State ---
let currentConfig: Config | null = null;
let vaultData: Uint8Array | null = null;

// --- DOM refs ---
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
const masterPassword = $("master-password") as HTMLInputElement;
const unlockStatus = $("unlock-status");
const vaultContent = $("vault-content") as HTMLElement;
const vaultSummary = $("vault-summary") as HTMLPreElement;

// --- Helpers ---

function setStatus(el: HTMLElement, msg: string, isError = false) {
  el.textContent = msg;
  el.className = `status ${isError ? "error" : "success"}`;
}

function clearStatus(el: HTMLElement) {
  el.textContent = "";
  el.className = "status";
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

// --- Initial load ---

async function init() {
  // Load config from storage
  const response = await browser.runtime.sendMessage({ type: "CONFIG_GET" });
  if (response) {
    currentConfig = response as Config;
    applyConfig(currentConfig);
  }
}

init().catch(console.error);

// --- Save Config ---

s3Form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(statusMsg);

  const cfg = toConfig();

  try {
    await browser.runtime.sendMessage({ type: "CONFIG_SET", payload: cfg });
    currentConfig = cfg;
    setStatus(statusMsg, "Configuration saved successfully.");
  } catch (err) {
    setStatus(statusMsg, `Failed to save config: ${(err as Error).message}`, true);
  }
});

// --- Pull Vault ---

pullBtn.addEventListener("click", async () => {
  clearStatus(statusMsg);
  clearStatus(unlockStatus);
  vaultContent.style.display = "none";
  vaultData = null;

  const cfg = currentConfig ?? toConfig();

  if (!cfg.s3_bucket || !cfg.s3_key || !cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
    setStatus(statusMsg, "Please fill in all S3 fields first.", true);
    return;
  }

  pullBtn.disabled = true;
  pullBtn.textContent = "Pulling...";

  try {
    const data = await s3Download({
      endpoint: cfg.s3_endpoint || undefined,
      region: cfg.s3_region || "us-east-1",
      bucket: cfg.s3_bucket,
      key: cfg.s3_key,
      accessKeyId: cfg.aws_access_key_id,
      secretAccessKey: cfg.aws_secret_access_key,
    });

    vaultData = data;
    setStatus(statusMsg, "Vault pulled from S3 successfully.");
    unlockSection.style.display = "block";
  } catch (err) {
    setStatus(statusMsg, `Failed to pull vault: ${(err as Error).message}`, true);
  } finally {
    pullBtn.disabled = false;
    pullBtn.textContent = "Pull Vault from S3";
  }
});

// --- Unlock Vault ---

unlockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(unlockStatus);
  vaultContent.style.display = "none";

  const password = masterPassword.value.trim();
  if (!password) {
    setStatus(unlockStatus, "Please enter a master password.", true);
    return;
  }

  if (!vaultData) {
    setStatus(unlockStatus, "No vault data. Pull from S3 first.", true);
    return;
  }

  try {
    const vault = await loadStore(vaultData, password);
    const keys = listKeys(vault);

    vaultSummary.textContent =
      `Version: ${vault.version}\n` +
      `Entries: ${keys.length}\n\n` +
      (keys.length > 0 ? `Keys:\n  ${keys.join("\n  ")}` : "(empty vault)");

    vaultContent.style.display = "block";
    setStatus(unlockStatus, "Vault unlocked successfully!");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("wrong master password") || msg.includes("WRONG_PASSWORD")) {
      setStatus(unlockStatus, "Wrong master password.", true);
    } else {
      setStatus(unlockStatus, `Failed to unlock: ${msg}`, true);
    }
  }
});
