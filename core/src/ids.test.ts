import { describe, expect, it } from "vitest";
import { loadStore, saveStore } from "./store.js";
import { ensureIds, newVault, withPreservedFields, type Entry, type Vault } from "./vault.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function entry(extra: Partial<Entry> = {}): Entry {
  return { metadata: { password: "p" }, created_at: "t", updated_at: "t", ...extra };
}

describe("ensureIds", () => {
  it("assigns missing ids, keeps unique ones, and splits duplicates", () => {
    const v: Vault = {
      version: 1,
      entries: { keep: entry({ id: "kept-id" }), missing: entry(), "a-dup": entry({ id: "dup" }), "b-dup": entry({ id: "dup" }) },
    };
    ensureIds(v);
    expect(v.entries.keep.id).toBe("kept-id");
    expect(v.entries.missing.id).toMatch(UUID_V4);
    expect(v.entries["a-dup"].id).toBe("dup");
    expect(v.entries["b-dup"].id).toMatch(UUID_V4);
  });
});

describe("ids through the store", () => {
  it("saveStore assigns ids, and they're stable across load/save", async () => {
    const v = newVault();
    v.entries.github = entry();
    const bytes = await saveStore(v, "pw");
    const id = v.entries.github.id;
    expect(id).toMatch(UUID_V4); // the caller's copy got it too
    const back = await loadStore(await saveStore(await loadStore(bytes, "pw"), "pw"), "pw");
    expect(back.entries.github.id).toBe(id);
  }, 60_000); // real Argon2id

  it("an edit that rebuilds the entry keeps its id; a rename moves it", () => {
    const prev = entry({ id: "abc" });
    const rebuilt = withPreservedFields(prev, entry({ updated_at: "later" }));
    expect(rebuilt.id).toBe("abc");
  });
});
