/**
 * Regression tests for the "AWS SSO" / "AWS" report: two entries share
 * username and password but have different OTP URIs. The core layers (vault
 * model, encrypted store round trip, OTP canonicalization) must never merge or
 * deduplicate entries by username/password: entries are keyed by name only.
 */
import { describe, expect, it } from "vitest";
import { generateTotp, normalizeOtpInput, parseOtpauthUri } from "./otp.js";
import { loadStore, saveStore } from "./store.js";
import { addEntry, newVault, type Entry } from "./vault.js";

// Fixture secrets only — never real ones.
const SSO_OTP = "otpauth://totp/AWS%20SSO:alice?secret=JBSWY3DPEHPK3PXP&issuer=AWS%20SSO";
const AWS_OTP = "otpauth://totp/Amazon%20Web%20Services:alice@123456789012?secret=KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ&issuer=Amazon%20Web%20Services";

function awsEntry(otp: string): Entry {
  return {
    metadata: { username: "alice", password: "same-password", url: "https://console.aws.amazon.com", otp },
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T10:00:00.000Z",
  };
}

describe("two entries with the same username/password, different OTP", () => {
  it("the fixture OTPs really are different secrets producing different codes", async () => {
    expect(parseOtpauthUri(SSO_OTP).secret).not.toBe(parseOtpauthUri(AWS_OTP).secret);
    const t = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect((await generateTotp(SSO_OTP, t)).code).not.toBe((await generateTotp(AWS_OTP, t)).code);
  });

  it("the vault model keys entries by name only: both are kept", () => {
    const v = newVault();
    addEntry(v, "AWS SSO", awsEntry(SSO_OTP));
    addEntry(v, "AWS", awsEntry(AWS_OTP));
    expect(Object.keys(v.entries).sort()).toEqual(["AWS", "AWS SSO"]);
    expect(v.entries["AWS"].metadata.otp).toBe(AWS_OTP);
    expect(v.entries["AWS SSO"].metadata.otp).toBe(SSO_OTP);
  });

  it("survives the encrypted store round trip unchanged", async () => {
    const v = newVault();
    addEntry(v, "AWS SSO", awsEntry(SSO_OTP));
    addEntry(v, "AWS", awsEntry(AWS_OTP));
    const back = await loadStore(await saveStore(v, "fixture-password"), "fixture-password");
    expect(back).toEqual(v);
  }, 30_000); // real Argon2id

  it("OTP canonicalization keeps each entry's own secret", async () => {
    const sso = await normalizeOtpInput(SSO_OTP, "AWS SSO");
    const aws = await normalizeOtpInput(AWS_OTP, "AWS");
    expect(parseOtpauthUri(sso).secret).toBe(parseOtpauthUri(SSO_OTP).secret);
    expect(parseOtpauthUri(aws).secret).toBe(parseOtpauthUri(AWS_OTP).secret);
  });
});
