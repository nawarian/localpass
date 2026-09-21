import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotp,
  normalizeOtpInput,
  parseOtpauthUri,
  type OtpAlgorithm,
} from "./otp.js";
import { loadStore, saveStore } from "./store.js";
import { newVault } from "./vault.js";

const ascii = (s: string) => new TextEncoder().encode(s);

// RFC 6238 Appendix B seeds.
const SEEDS: Record<OtpAlgorithm, string> = {
  SHA1: base32Encode(ascii("12345678901234567890")),
  SHA256: base32Encode(ascii("12345678901234567890123456789012")),
  SHA512: base32Encode(ascii("1234567890123456789012345678901234567890123456789012345678901234")),
};

// [unix time, SHA1, SHA256, SHA512] — 8 digits, 30s period.
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("base32", () => {
  it("round-trips and matches the RFC 4648 alphabet", () => {
    expect(base32Encode(ascii("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(new TextDecoder().decode(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"))).toBe(
      "12345678901234567890",
    );
    expect(new TextDecoder().decode(base32Decode("MZXW6==="))).toBe("foo");
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC1")).toThrow(/Invalid Base32/);
  });
});

describe("RFC 6238 test vectors", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    const expected: Record<OtpAlgorithm, string> = { SHA1: sha1, SHA256: sha256, SHA512: sha512 };
    for (const algorithm of ["SHA1", "SHA256", "SHA512"] as OtpAlgorithm[]) {
      it(`${algorithm} @ ${t}`, async () => {
        const uri = `otpauth://totp/test?secret=${SEEDS[algorithm]}&algorithm=${algorithm}&digits=8&period=30`;
        const res = await generateTotp(uri, t * 1000);
        expect(res.code).toBe(expected[algorithm]);
      });
    }
  }
});

describe("generateTotp", () => {
  it("defaults to SHA1 / 6 digits / 30s", async () => {
    const res = await generateTotp(`otpauth://totp/x?secret=${SEEDS.SHA1}`, 59_000);
    expect(res.code).toBe("287082");
    expect(res.period).toBe(30);
    expect(res.remaining).toBe(1);
  });

  it("honors a custom period", async () => {
    const res = await generateTotp(`otpauth://totp/x?secret=${SEEDS.SHA1}&period=60`, 61_000);
    expect(res.period).toBe(60);
    expect(res.remaining).toBe(59);
  });
});

describe("parseOtpauthUri", () => {
  it("parses label, issuer and parameters", () => {
    const p = parseOtpauthUri(
      "otpauth://totp/ACME%20Co:john@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=45",
    );
    expect(p).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      label: "ACME Co:john@example.com",
      issuer: "ACME Co",
      algorithm: "SHA256",
      digits: 8,
      period: 45,
    });
  });

  it("rejects hotp", () => {
    expect(() => parseOtpauthUri("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=0")).toThrow(/HOTP/);
  });

  it("rejects unknown algorithms", () => {
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow(
      /Unsupported OTP algorithm/,
    );
  });

  it("rejects a missing or invalid secret", () => {
    expect(() => parseOtpauthUri("otpauth://totp/x?issuer=a")).toThrow(/missing its secret/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=not-base32!")).toThrow(/Invalid Base32/);
  });

  it("rejects out-of-range digits", () => {
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4")).toThrow(/digits/);
  });
});

describe("normalizeOtpInput", () => {
  it("builds a canonical URI from a bare secret", async () => {
    const uri = await normalizeOtpInput("  jbsw y3dp ehpk 3pxp ", "github.com");
    expect(uri).toBe(
      "otpauth://totp/github.com?secret=JBSWY3DPEHPK3PXP&issuer=github.com&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("canonicalizes a full URI and is idempotent", async () => {
    const once = await normalizeOtpInput(
      "otpauth://TOTP/GitHub:alice?secret=jbswy3dpehpk3pxp&issuer=GitHub",
      "ignored",
    );
    expect(once).toBe(
      "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30",
    );
    expect(await normalizeOtpInput(once, "ignored")).toBe(once);
    expect(buildOtpauthUri(parseOtpauthUri(once))).toBe(once);
  });

  it("rejects bad input", async () => {
    await expect(normalizeOtpInput("", "k")).rejects.toThrow(/empty/);
    await expect(normalizeOtpInput("hello world!", "k")).rejects.toThrow(/Invalid Base32/);
    await expect(normalizeOtpInput("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP", "k")).rejects.toThrow(/HOTP/);
  });
});

describe("vault round-trip", () => {
  it("keeps version 1 with and without an otp field", { timeout: 60_000 }, async () => {
    const vault = newVault();
    const now = new Date().toISOString();
    vault.entries["plain"] = { metadata: { password: "x" }, created_at: now, updated_at: now };
    vault.entries["with-otp"] = {
      metadata: { password: "y", otp: await normalizeOtpInput("JBSWY3DPEHPK3PXP", "with-otp") },
      created_at: now,
      updated_at: now,
    };
    const loaded = await loadStore(await saveStore(vault, "pw"), "pw");
    expect(loaded.version).toBe(1);
    expect(loaded.entries).toEqual(vault.entries);
  });
});
