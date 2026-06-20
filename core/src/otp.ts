/**
 * TOTP (RFC 6238) support — a hand-rolled, dependency-free implementation built
 * on WebCrypto (crypto.subtle HMAC) plus a small Base32 (RFC 4648) decoder.
 *
 * This is the TypeScript side of a deliberate parallel implementation; the Go
 * port lives in cli/internal/store/otp.go and both are pinned to the same
 * RFC 6238 Appendix B test vectors.
 *
 * Codes are derived purely from the system clock — there is no NTP or
 * clock-skew correction. We only ever generate codes (never validate against a
 * window), so a wrong machine clock yields wrong codes by design.
 */

export type OTPAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface OTPConfig {
  secret: Uint8Array; // Base32-decoded shared secret
  algorithm: OTPAlgorithm;
  digits: number;
  period: number; // seconds
  label: string; // account label from the URI path
  issuer: string; // issuer query parameter (may be empty)
}

const DEFAULT_ALGORITHM: OTPAlgorithm = "SHA1";
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const SUBTLE_HASH: Record<OTPAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

/** Trim, uppercase, strip embedded spaces and remove padding. */
export function normalizeBase32(s: string): string {
  return s.trim().toUpperCase().replace(/ /g, "").replace(/=+$/, "");
}

/** Decode a normalized Base32 (RFC 4648) secret to bytes. */
export function decodeBase32(input: string): Uint8Array {
  const s = normalizeBase32(input);
  if (s === "") {
    throw new Error("otp secret is empty");
  }
  const out: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error("invalid Base32 secret");
    }
    buffer = (buffer << 5) | idx;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out.push((buffer >> bitsLeft) & 0xff);
      buffer &= (1 << bitsLeft) - 1; // retain only the leftover low bits
    }
  }
  if (out.length === 0) {
    throw new Error("otp secret decodes to zero bytes");
  }
  return new Uint8Array(out);
}

/**
 * Parse and validate an otpauth:// TOTP URI. HOTP URIs and unknown algorithm
 * values are rejected loudly.
 */
export function parseOtpAuth(rawURI: string): OTPConfig {
  let u: URL;
  try {
    u = new URL(rawURI.trim());
  } catch {
    throw new Error("invalid otpauth URI");
  }
  if (u.protocol.toLowerCase() !== "otpauth:") {
    throw new Error("not an otpauth:// URI");
  }

  const type = u.host.toLowerCase();
  if (type === "hotp") {
    throw new Error(
      "HOTP is not supported (counter-based OTP would break sync); use a TOTP URI",
    );
  }
  if (type !== "totp") {
    throw new Error(`unsupported otpauth type "${u.host}" (expected totp)`);
  }

  const secret = u.searchParams.get("secret");
  if (!secret) {
    throw new Error("otpauth URI is missing the secret parameter");
  }
  const decoded = decodeBase32(secret);

  let algorithm = DEFAULT_ALGORITHM;
  const a = u.searchParams.get("algorithm");
  if (a) {
    const upper = a.toUpperCase();
    if (upper !== "SHA1" && upper !== "SHA256" && upper !== "SHA512") {
      throw new Error(
        `unknown OTP algorithm "${a}" (expected SHA1, SHA256 or SHA512)`,
      );
    }
    algorithm = upper;
  }

  let digits = DEFAULT_DIGITS;
  const d = u.searchParams.get("digits");
  if (d) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 1 || n > 8) {
      throw new Error(`invalid OTP digits "${d}" (expected 1-8)`);
    }
    digits = n;
  }

  let period = DEFAULT_PERIOD;
  const p = u.searchParams.get("period");
  if (p) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`invalid OTP period "${p}" (expected a positive integer)`);
    }
    period = n;
  }

  return {
    secret: decoded,
    algorithm,
    digits,
    period,
    label: decodeURIComponent(u.pathname.replace(/^\//, "")),
    issuer: u.searchParams.get("issuer") ?? "",
  };
}

/** Compute the TOTP code for the given time (ms since epoch). */
export async function generateTotp(
  cfg: OTPConfig,
  atMs: number,
): Promise<string> {
  if (cfg.period <= 0) {
    throw new Error("invalid OTP period");
  }
  const counter = BigInt(Math.floor(atMs / 1000)) / BigInt(cfg.period);

  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setBigUint64(0, counter, false); // big-endian

  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(cfg.secret) as BufferSource,
    { name: "HMAC", hash: SUBTLE_HASH[cfg.algorithm] },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = sig[sig.length - 1] & 0x0f;
  const binCode =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];

  const mod = 10 ** cfg.digits;
  return (binCode % mod).toString().padStart(cfg.digits, "0");
}

/** Seconds remaining in the current period for the given time (ms). */
export function otpSecondsRemaining(period: number, atMs: number): number {
  const p = period > 0 ? period : DEFAULT_PERIOD;
  return p - (Math.floor(atMs / 1000) % p);
}

function canonicalOtpUri(normalizedSecret: string, entryKey: string): string {
  const params = new URLSearchParams();
  params.set("secret", normalizedSecret);
  params.set("issuer", entryKey);
  params.set("algorithm", DEFAULT_ALGORITHM);
  params.set("digits", String(DEFAULT_DIGITS));
  params.set("period", String(DEFAULT_PERIOD));
  return `otpauth://totp/${encodeURIComponent(entryKey)}?${params.toString()}`;
}

/**
 * Accept either a full otpauth:// TOTP URI or a bare Base32 secret and return a
 * canonical otpauth:// URI ready to persist. A bare secret is wrapped using RFC
 * defaults and the entry key as label/issuer. The input is fully validated and
 * a code is test-generated before returning, so a bad seed never persists.
 */
export async function normalizeOtp(
  input: string,
  entryKey: string,
): Promise<string> {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("otp input is empty");
  }

  let uri: string;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("otpauth://")) {
    uri = trimmed;
  } else if (lower.startsWith("otpauth-migration://")) {
    throw new Error(
      "otpauth-migration:// (bulk export) URIs are not supported; provide a single otpauth://totp/ URI",
    );
  } else {
    uri = canonicalOtpUri(normalizeBase32(trimmed), entryKey);
  }

  const cfg = parseOtpAuth(uri); // validates
  await generateTotp(cfg, Date.now()); // test-generate
  return uri;
}

export interface OTPResult {
  code: string;
  secondsRemaining: number;
  period: number;
}

/** Parse a URI and return the current code plus seconds remaining. */
export async function generateOtp(
  rawURI: string,
  atMs: number,
): Promise<OTPResult> {
  const cfg = parseOtpAuth(rawURI);
  const code = await generateTotp(cfg, atMs);
  return {
    code,
    secondsRemaining: otpSecondsRemaining(cfg.period, atMs),
    period: cfg.period,
  };
}

/**
 * Replace the secret parameter value with "****", leaving the rest readable.
 * Used so the raw seed never surfaces unless explicitly revealed.
 */
export function maskOtpSecret(rawURI: string): string {
  return rawURI.replace(/([?&]secret=)[^&]*/, "$1****");
}
