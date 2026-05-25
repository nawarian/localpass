import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  generateOtp,
  generateTotp,
  maskOtpSecret,
  normalizeOtp,
  otpSecondsRemaining,
  parseOtpAuth,
  type OTPAlgorithm,
} from "./otp.js";

// RFC 6238 Appendix B seeds, sized per algorithm block length.
const seedSHA1 = new TextEncoder().encode("12345678901234567890");
const seedSHA256 = new TextEncoder().encode("12345678901234567890123456789012");
const seedSHA512 = new TextEncoder().encode(
  "1234567890123456789012345678901234567890123456789012345678901234",
);

describe("RFC 6238 test vectors", () => {
  const cases: Array<{
    unix: number;
    sha1: string;
    sha256: string;
    sha512: string;
  }> = [
    { unix: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
    { unix: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
    { unix: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
    { unix: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
    { unix: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
    { unix: 20000000000, sha1: "65353130", sha256: "77737706", sha512: "47863826" },
  ];

  for (const tc of cases) {
    const variants: Array<{ algo: OTPAlgorithm; secret: Uint8Array; want: string }> = [
      { algo: "SHA1", secret: seedSHA1, want: tc.sha1 },
      { algo: "SHA256", secret: seedSHA256, want: tc.sha256 },
      { algo: "SHA512", secret: seedSHA512, want: tc.sha512 },
    ];
    for (const v of variants) {
      it(`${v.algo} @ ${tc.unix}`, async () => {
        const code = await generateTotp(
          { secret: v.secret, algorithm: v.algo, digits: 8, period: 30, label: "", issuer: "" },
          tc.unix * 1000,
        );
        expect(code).toBe(v.want);
      });
    }
  }
});

describe("decodeBase32", () => {
  it("decodes the SHA1 RFC seed", () => {
    const decoded = decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(new TextDecoder().decode(decoded)).toBe("12345678901234567890");
  });

  it("normalizes whitespace and case", () => {
    const decoded = decodeBase32("gezd gnbv gy3t qojq");
    expect(new TextDecoder().decode(decoded)).toBe("1234567890");
  });

  it("rejects invalid Base32", () => {
    expect(() => decodeBase32("not-base-32!!!")).toThrow();
  });
});

describe("parseOtpAuth", () => {
  it("applies RFC defaults", () => {
    const cfg = parseOtpAuth(
      "otpauth://totp/ACME:alice@example.com?secret=GEZDGNBVGY3TQOJQ&issuer=ACME",
    );
    expect(cfg.algorithm).toBe("SHA1");
    expect(cfg.digits).toBe(6);
    expect(cfg.period).toBe(30);
    expect(cfg.issuer).toBe("ACME");
  });

  it("honors explicit parameters", () => {
    const cfg = parseOtpAuth(
      "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60",
    );
    expect(cfg.algorithm).toBe("SHA256");
    expect(cfg.digits).toBe(8);
    expect(cfg.period).toBe(60);
  });

  it("rejects HOTP", () => {
    expect(() =>
      parseOtpAuth("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=0"),
    ).toThrow(/HOTP/);
  });

  it("rejects unknown algorithm", () => {
    expect(() =>
      parseOtpAuth("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5"),
    ).toThrow(/algorithm/);
  });
});

describe("normalizeOtp", () => {
  it("wraps a bare secret into a canonical URI", async () => {
    const uri = await normalizeOtp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "github.com");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const cfg = parseOtpAuth(uri);
    expect(cfg.issuer).toBe("github.com");
    expect(cfg.algorithm).toBe("SHA1");
    expect(new TextDecoder().decode(cfg.secret)).toBe("12345678901234567890");
  });

  it("passes a full URI through unchanged", async () => {
    const input = "otpauth://totp/ACME:alice?secret=GEZDGNBVGY3TQOJQ&issuer=ACME";
    expect(await normalizeOtp(input, "ignored")).toBe(input);
  });

  it("rejects HOTP at normalize time", async () => {
    await expect(
      normalizeOtp("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=0", "x"),
    ).rejects.toThrow();
  });

  it("rejects an invalid bare secret", async () => {
    await expect(normalizeOtp("0189!!", "x")).rejects.toThrow();
  });
});

describe("otpSecondsRemaining", () => {
  it("returns time left in the window", () => {
    expect(otpSecondsRemaining(30, 25_000)).toBe(5);
    expect(otpSecondsRemaining(30, 30_000)).toBe(30);
  });
});

describe("generateOtp", () => {
  it("returns the current code and seconds remaining", async () => {
    const res = await generateOtp(
      "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8",
      59_000,
    );
    expect(res.code).toBe("94287082");
    expect(res.secondsRemaining).toBe(1);
    expect(res.period).toBe(30);
  });
});

describe("maskOtpSecret", () => {
  it("redacts the secret but keeps other params", () => {
    const masked = maskOtpSecret(
      "otpauth://totp/ACME:alice?secret=GEZDGNBVGY3TQOJQ&issuer=ACME&period=30",
    );
    expect(masked).not.toContain("GEZDGNBVGY3TQOJQ");
    expect(masked).toContain("secret=****");
    expect(masked).toContain("issuer=ACME");
    expect(masked).toContain("period=30");
  });
});
