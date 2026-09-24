/**
 * Regression tests for the "AWS SSO" / "AWS" report: a second entry with the
 * same username and password but its own OTP was made by editing "AWS SSO"
 * and changing its name. Saving renamed it — deleting "AWS SSO" without a
 * word — and, when the OTP field was left alone, "AWS" got AWS SSO's OTP.
 */
import { describe, expect, it } from "vitest";
import type { Entry, Vault } from "@localpass/core";
import {
  applyDraft,
  draftToEntry,
  duplicateDraft,
  entryToDraft,
  newDraft,
  renameConfirmMessage,
  saveKind,
  type EditDraft,
} from "./lib";

// Fixture secrets only.
const SSO_OTP = "otpauth://totp/AWS%20SSO:alice?secret=JBSWY3DPEHPK3PXP&issuer=AWS%20SSO";
const AWS_OTP =
  "otpauth://totp/Amazon%20Web%20Services:alice@123456789012?secret=KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ&issuer=Amazon%20Web%20Services";

const SSO: Entry = {
  metadata: {
    username: "alice",
    password: "same-password",
    url: "https://my-sso.awsapps.com/start",
    otp: SSO_OTP,
    account: "123456789012",
  },
  created_at: "2026-09-20T10:00:00.000Z",
  updated_at: "2026-09-20T10:00:00.000Z",
};

function vaultWithSso(): Vault {
  return { version: 1, entries: { "AWS SSO": structuredClone(SSO) } };
}

/** Save `draft` the way the popup does: apply it to the pulled vault. */
function save(vault: Vault, draft: EditDraft): string | null {
  return applyDraft(vault, draft, draftToEntry(draft, draft.createdAt));
}

describe("saveKind", () => {
  it("tells new, update and rename apart", () => {
    const edit = entryToDraft("AWS SSO", SSO);
    expect(saveKind(newDraft())).toBe("new");
    expect(saveKind(edit)).toBe("update");
    expect(saveKind({ ...edit, key: "  AWS SSO " })).toBe("update"); // trimmed like the save
    expect(saveKind({ ...edit, key: "AWS" })).toBe("rename");
  });

  it("treats a restored edit snapshot with a changed name as a rename too", () => {
    // What savePopupUI keeps in storage.session while "AWS SSO" is being edited.
    const snapshot = JSON.parse(JSON.stringify(entryToDraft("AWS SSO", SSO))) as EditDraft;
    expect(saveKind({ ...snapshot, key: "AWS" })).toBe("rename");
  });

  it("the rename confirmation names what disappears and points to Duplicate", () => {
    const msg = renameConfirmMessage({ ...entryToDraft("AWS SSO", SSO), key: " AWS " });
    expect(msg).toContain('Rename "AWS SSO" to "AWS"?');
    expect(msg).toContain('"AWS SSO" will no longer exist');
    expect(msg).toContain("Duplicate");
  });
});

describe("duplicateDraft", () => {
  it("is a new item with the same details but an empty OTP", () => {
    const d = duplicateDraft("AWS SSO", SSO, vaultWithSso().entries);
    expect(d.originalKey).toBeNull();
    expect(saveKind(d)).toBe("new");
    expect(d.key).toBe("AWS SSO (copy)");
    expect(d.username).toBe("alice");
    expect(d.password).toBe("same-password");
    expect(d.website).toBe("https://my-sso.awsapps.com/start");
    expect(d.custom.map((c) => [c.name, c.value])).toEqual([["account", "123456789012"]]);
    expect(d.otp).toBe("");
    expect(d.createdAt).toBeNull();
  });

  it("picks a copy name that isn't taken", () => {
    const entries = { "AWS SSO": SSO, "AWS SSO (copy)": SSO, "AWS SSO (copy 2)": SSO };
    expect(duplicateDraft("AWS SSO", SSO, entries).key).toBe("AWS SSO (copy 3)");
  });

  it("gives the copy fresh custom-field ids", () => {
    const edit = entryToDraft("AWS SSO", SSO);
    const dup = duplicateDraft("AWS SSO", SSO, {});
    expect(dup.custom[0].id).not.toBe(edit.custom[0].id);
  });
});

describe("the reported scenario", () => {
  it("New item with the same username/password and another OTP keeps both entries", () => {
    const v = vaultWithSso();
    const draft: EditDraft = { ...newDraft(), key: "AWS", username: "alice", password: "same-password", otp: AWS_OTP };
    expect(save(v, draft)).toBeNull();
    expect(Object.keys(v.entries).sort()).toEqual(["AWS", "AWS SSO"]);
    expect(v.entries["AWS"].metadata.otp).toBe(AWS_OTP);
    expect(v.entries["AWS SSO"]).toEqual(SSO);
  });

  it("Duplicate → rename the copy → set its OTP keeps both entries, each with its own OTP", () => {
    const v = vaultWithSso();
    const draft = { ...duplicateDraft("AWS SSO", SSO, v.entries), key: "AWS", otp: AWS_OTP };
    expect(save(v, draft)).toBeNull();
    expect(Object.keys(v.entries).sort()).toEqual(["AWS", "AWS SSO"]);
    expect(v.entries["AWS"].metadata.otp).toBe(AWS_OTP);
    expect(v.entries["AWS SSO"]).toEqual(SSO);
  });

  it("Duplicate with only the name changed never carries AWS SSO's OTP over", () => {
    const v = vaultWithSso();
    const draft = { ...duplicateDraft("AWS SSO", SSO, v.entries), key: "AWS" };
    save(v, draft);
    expect(v.entries["AWS"].metadata.otp).toBeUndefined();
    expect(v.entries["AWS SSO"].metadata.otp).toBe(SSO_OTP);
  });

  it("a confirmed rename still moves the entry (and is the only path that removes the old name)", () => {
    const v = vaultWithSso();
    const draft = { ...entryToDraft("AWS SSO", SSO), key: "AWS" };
    expect(saveKind(draft)).toBe("rename"); // the popup asks before getting here
    expect(save(v, draft)).toBeNull();
    expect(Object.keys(v.entries)).toEqual(["AWS"]);
  });

  it("an update keeps the name and replaces the entry in place", () => {
    const v = vaultWithSso();
    const draft = { ...entryToDraft("AWS SSO", SSO), notes: "rotated" };
    expect(save(v, draft)).toBeNull();
    expect(Object.keys(v.entries)).toEqual(["AWS SSO"]);
    expect(v.entries["AWS SSO"].metadata.notes).toBe("rotated");
    expect(v.entries["AWS SSO"].created_at).toBe(SSO.created_at);
  });

  it("never overwrites another entry: new or renamed onto a taken name is refused", () => {
    const v = vaultWithSso();
    v.entries["AWS"] = { ...structuredClone(SSO), metadata: { ...SSO.metadata, otp: AWS_OTP } };
    const before = structuredClone(v);
    expect(save(v, { ...newDraft(), key: "AWS", otp: SSO_OTP })).toBe('Item "AWS" already exists');
    expect(save(v, { ...entryToDraft("AWS SSO", SSO), key: "AWS" })).toBe('Item "AWS" already exists');
    expect(v).toEqual(before);
  });
});
