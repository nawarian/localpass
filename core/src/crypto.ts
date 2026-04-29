/**
 * Cryptographic primitives for LocalPass.
 *
 * Port of the Go implementation (cli/internal/store/crypto.go):
 *   - Key derivation via Argon2id
 *   - Encryption / decryption with AES-256-GCM
 *
 * Wire format: salt (16) || nonce (12) || ciphertext || auth_tag
 */

import { argon2id } from "@noble/hashes/argon2";

const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32; // AES-256

// Argon2id parameters (matching Go defaults)
const ARGON_TIME = 3;
const ARGON_MEM = 64 * 1024; // 64 MiB in KiB
const ARGON_THREADS = 4;

export class DecryptError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_CIPHERTEXT" | "WRONG_PASSWORD"
  ) {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * Derive a 32-byte key from a primary password and salt using Argon2id.
 */
export function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return argon2id(password, salt, {
    t: ARGON_TIME,
    m: ARGON_MEM,
    p: ARGON_THREADS,
    dkLen: KEY_LEN,
  });
}

/**
 * Encrypt plaintext with a primary password.
 *
 * Returns: salt (16) || nonce (12) || ciphertext || auth_tag
 */
export async function encrypt(
  plaintext: Uint8Array,
  primaryPassword: string
): Promise<Uint8Array> {
  // Generate random salt and nonce
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));

  // Derive key
  const key = deriveKey(primaryPassword, salt);

  // Import key for AES-GCM (cast via Uint8Array to satisfy lib type variances)
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key) as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce) as BufferSource },
    cryptoKey,
    new Uint8Array(plaintext) as BufferSource
  );

  // Concatenate: salt || nonce || ciphertext
  const ciphertext = new Uint8Array(encrypted);
  const out = new Uint8Array(SALT_LEN + NONCE_LEN + ciphertext.length);
  out.set(salt, 0);
  out.set(nonce, SALT_LEN);
  out.set(ciphertext, SALT_LEN + NONCE_LEN);

  return out;
}

/**
 * Decrypt data produced by encrypt().
 *
 * Input format: salt (16) || nonce (12) || ciphertext || auth_tag
 */
export async function decrypt(
  data: Uint8Array,
  primaryPassword: string
): Promise<Uint8Array> {
  if (data.length < SALT_LEN + NONCE_LEN) {
    throw new DecryptError(
      "ciphertext is too short",
      "INVALID_CIPHERTEXT"
    );
  }

  const salt = data.subarray(0, SALT_LEN);
  const nonce = data.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
  const ciphertext = data.subarray(SALT_LEN + NONCE_LEN);

  // Derive key
  const key = deriveKey(primaryPassword, salt);

  // Import key for AES-GCM
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key) as BufferSource,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
  } catch {
    throw new DecryptError(
      "failed to import key",
      "WRONG_PASSWORD"
    );
  }

  // Decrypt
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce) as BufferSource },
      cryptoKey,
      new Uint8Array(ciphertext) as BufferSource
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new DecryptError(
      "wrong primary password or corrupted data",
      "WRONG_PASSWORD"
    );
  }
}
