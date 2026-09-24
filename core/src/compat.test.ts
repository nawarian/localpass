import { describe, expect, it } from "vitest";
import { encrypt } from "./crypto.js";
import { VaultVersionError, loadStore, saveStore } from "./store.js";
import { SUPPORTED_VAULT_VERSION, withPreservedFields, type Entry } from "./vault.js";

// A vault as a newer client might write it: unknown fields at the top level
// and on an entry.
const NEWER = {
  version: 1,
  sync_hint: { device: "laptop" },
  entries: {
    github: {
      id: "0b5f7c1e-8d0c-4c47-9b1f-6d2f0a7c9e11",
      metadata: { password: "a" },
      created_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-20T10:00:00.000Z",
      tags: ["dev"],
    },
  },
};

async function encryptJson(value: unknown): Promise<Uint8Array> {
  return encrypt(new TextEncoder().encode(JSON.stringify(value)), "pw");
}

describe("forward compatibility", () => {
  it("keeps unknown fields through load and save", async () => {
    const v = await loadStore(await encryptJson(NEWER), "pw");
    expect(await loadStore(await saveStore(v, "pw"), "pw")).toEqual(NEWER);
  }, 30_000); // real Argon2id

  it("reads a newer vault but refuses to save it", async () => {
    const v = await loadStore(await encryptJson({ ...NEWER, version: SUPPORTED_VAULT_VERSION + 1 }), "pw");
    expect(v.entries.github.metadata.password).toBe("a");
    const err = await saveStore(v, "pw").catch((e) => e);
    expect(err).toBeInstanceOf(VaultVersionError);
    expect(err.message).toMatch(/newer LocalPass.*Update LocalPass/);
  }, 30_000);
});

describe("withPreservedFields", () => {
  const prev = NEWER.entries.github as Entry;
  const next: Entry = { metadata: { password: "b" }, created_at: prev.created_at, updated_at: "2026-09-24T00:00:00.000Z" };

  it("carries unknown fields over to a rebuilt entry, which wins on known fields", () => {
    expect(withPreservedFields(prev, next)).toEqual({ ...next, id: prev.id, tags: ["dev"] });
  });

  it("returns the new entry unchanged when there was none before", () => {
    expect(withPreservedFields(undefined, next)).toBe(next);
  });
});
