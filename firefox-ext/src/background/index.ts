/**
 * LocalPass Background Script
 *
 * Handles storage of config credentials (encrypted in browser storage)
 * and acts as a bridge for S3 operations so that the content script
 * doesn't need direct S3 access.
 */

import type { Config } from "@localpass/core";

const CONFIG_KEY = "localpass:config";

/**
 * Load the stored config from browser.storage.local.
 */
export async function loadConfig(): Promise<Config | null> {
  const result = await browser.storage.local.get(CONFIG_KEY);
  return (result[CONFIG_KEY] as Config) ?? null;
}

/**
 * Save config to browser.storage.local.
 */
export async function saveConfig(config: Config): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

// Listen for messages from options/popup pages
browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.runtime.MessageSender) => {
    const msg = message as { type: string; payload?: unknown };

    switch (msg.type) {
      case "CONFIG_GET":
        return loadConfig();
      case "CONFIG_SET":
        return saveConfig(msg.payload as Config).then(() => true);
      default:
        return undefined; // Not handled
    }
  }
);
