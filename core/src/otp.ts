/**
 * TOTP (RFC 6238) support for the `otp` entry field.
 *
 * An entry stores a single canonical `otpauth://totp/...` URI. Everything here
 * is hand-rolled on top of WebCrypto (HMAC) plus a small RFC 4648 Base32
 * codec, so there are no extra runtime dependencies.
 *
 * Codes are generated from the system clock; there is no skew correction.
 */

export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface OtpParams {
  /** Normalized Base32 secret (uppercase, no spaces or padding). */
  secret: string;
  /** Label path of the URI, decoded (e.g. "GitHub:alice"). */
  label: string;
  issuer: string | null;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
}

export interface OtpCode {
  code: string;
  /** Seconds left before the code rolls over (1..period). */
  remaining: number;
  period: number;
}

export class OtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpError";
  }
}

const DEFAULT_ALGORITHM: OtpAlgorithm = "SHA1";
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

const HASH_NAMES: Record<OtpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

// ---------- Base32 (RFC 4648) ----------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Uppercase, drop whitespace and trailing `=` padding. */
export function normalizeBase32(input: string): string {
  return input.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
}

export function base32Decode(input: string): Uint8Array {
  const s = normalizeBase32(input);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B32_ALPHABET.indexOf(ch);
    if (v < 0) throw new OtpError(`Invalid Base32 character '${ch}' in OTP secret.`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(data: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

// ---------- otpauth:// URIs ----------

const OTPAUTH_RE = /^otpauth:\/\/([^/?#]*)\/?([^?#]*)(?:\?([^#]*))?/i;

function parseAlgorithm(raw: string | null): OtpAlgorithm {
  if (raw === null || raw === "") return DEFAULT_ALGORITHM;
  const a = raw.toUpperCase().replace(/-/g, "");
  if (a === "SHA1" || a === "SHA256" || a === "SHA512") return a;
  throw new OtpError(`Unsupported OTP algorithm '${raw}' (expected SHA1, SHA256 or SHA512).`);
}

function parseIntParam(raw: string | null, name: string, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new OtpError(`Invalid OTP ${name} '${raw}'.`);
  const n = Number(raw);
  if (n < min || n > max) throw new OtpError(`OTP ${name} must be between ${min} and ${max}.`);
  return n;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse and validate an `otpauth://totp/...` URI. Throws OtpError. */
export function parseOtpauthUri(uri: string): OtpParams {
  const m = OTPAUTH_RE.exec(uri.trim());
  if (!m) throw new OtpError("Not an otpauth:// URI.");
  const type = m[1].toLowerCase();
  if (type === "hotp") {
    throw new OtpError("HOTP (counter-based) codes are not supported; only TOTP is.");
  }
  if (type !== "totp") throw new OtpError(`Unsupported OTP type '${m[1]}' (expected totp).`);

  const params = new URLSearchParams(m[3] ?? "");
  const secret = normalizeBase32(params.get("secret") ?? "");
  if (!secret) throw new OtpError("OTP URI is missing its secret.");
  if (base32Decode(secret).length === 0) throw new OtpError("OTP secret is empty.");

  return {
    secret,
    label: safeDecode(m[2]),
    issuer: params.get("issuer"),
    algorithm: parseAlgorithm(params.get("algorithm")),
    digits: parseIntParam(params.get("digits"), "digits", DEFAULT_DIGITS, 6, 8),
    period: parseIntParam(params.get("period"), "period", DEFAULT_PERIOD, 1, 3600),
  };
}

/** Serialize params into the canonical URI form stored in the vault. */
export function buildOtpauthUri(p: OtpParams): string {
  // Keep the conventional "Issuer:account" colon readable.
  const label = p.label.split(":").map(encodeURIComponent).join(":");
  const q = new URLSearchParams();
  q.set("secret", p.secret);
  if (p.issuer) q.set("issuer", p.issuer);
  q.set("algorithm", p.algorithm);
  q.set("digits", String(p.digits));
  q.set("period", String(p.period));
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ---------- code generation ----------

/** RFC 4226 HOTP value for a raw key and counter. */
export async function hotp(
  key: Uint8Array,
  counter: number,
  algorithm: OtpAlgorithm = DEFAULT_ALGORITHM,
  digits: number = DEFAULT_DIGITS,
): Promise<string> {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key), // copy onto a plain ArrayBuffer (BufferSource typing)
    { name: "HMAC", hash: HASH_NAMES[algorithm] },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg));

  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Current TOTP code for a stored `otp` value (an otpauth URI or parsed
 * params). `nowMs` defaults to the system clock.
 */
export async function generateTotp(otp: string | OtpParams, nowMs: number = Date.now()): Promise<OtpCode> {
  const p = typeof otp === "string" ? parseOtpauthUri(otp) : otp;
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / p.period);
  const code = await hotp(base32Decode(p.secret), counter, p.algorithm, p.digits);
  return { code, remaining: p.period - (seconds % p.period), period: p.period };
}

/**
 * Validate user input for the `otp` field and return the canonical URI to
 * persist. Accepts a full `otpauth://totp/...` URI or a bare Base32 secret;
 * a bare secret gets RFC defaults and `entryKey` as label and issuer. A code
 * is test-generated before returning, so a successful result is usable.
 */
export async function normalizeOtpInput(input: string, entryKey: string): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new OtpError("OTP value is empty.");

  let params: OtpParams;
  if (/^otpauth:/i.test(raw)) {
    params = parseOtpauthUri(raw);
  } else {
    const secret = normalizeBase32(raw);
    if (base32Decode(secret).length === 0) throw new OtpError("OTP secret is empty.");
    params = {
      secret,
      label: entryKey,
      issuer: entryKey || null,
      algorithm: DEFAULT_ALGORITHM,
      digits: DEFAULT_DIGITS,
      period: DEFAULT_PERIOD,
    };
  }

  await generateTotp(params);
  return buildOtpauthUri(params);
}
