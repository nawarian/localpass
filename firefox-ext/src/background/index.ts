/**
 * LocalPass Background Script
 *
 * Stores config and encrypted vault bytes. Decryption happens in the
 * popup/options page so we don't depend on service-worker memory persistence.
 */

import type { Config } from "@localpass/core";

const CONFIG_KEY = "localpass:config";
const VAULT_KEY = "localpass:vault";

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

async function setVaultBytesB64(b64: string): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: b64 });
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type: string; payload?: unknown };
  switch (msg.type) {
    case "CONFIG_GET":
      return loadConfig();
    case "CONFIG_SET":
      return saveConfig(msg.payload as Config).then(() => true);
    case "VAULT_BYTES_GET":
      return getVaultBytesB64();
    case "VAULT_BYTES_SET":
      return setVaultBytesB64((msg.payload as { b64: string }).b64).then(() => true);
    default:
      return undefined;
  }
});
