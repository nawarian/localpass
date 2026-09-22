/**
 * Random password generation.
 *
 * Uses WebCrypto `crypto.getRandomValues` with rejection sampling, so every
 * character is drawn uniformly (no modulo bias). Zero dependencies.
 */

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
// Conservative set: no quotes, backslash, spaces or angle brackets, which some
// sites reject or mangle.
const SYMBOLS = "!#$%&*+-=?@^_";

export const DEFAULT_PASSWORD_LENGTH = 20;

export interface GeneratePasswordOptions {
  /** Desired length before field constraints apply. Default 20. */
  length?: number;
  /** The target field's `minlength`; ignored when not positive. */
  minLength?: number;
  /** The target field's `maxlength`; ignored when not positive. */
  maxLength?: number;
  /** Include symbols. Default true. */
  symbols?: boolean;
}

/**
 * Uniform random integer in [0, n). Draws 32-bit values and rejects the ones
 * at or above the largest multiple of n, so `x % n` is unbiased.
 */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) {
    throw new Error(`randomInt: invalid bound ${n}`);
  }
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * Resolve the final length: start from `length`, then clamp into the field's
 * [minLength, maxLength] range. A field cap wins over our default, so a
 * `maxlength=16` field gets a 16-character password.
 */
export function resolvePasswordLength(opts: GeneratePasswordOptions = {}): number {
  let len = opts.length ?? DEFAULT_PASSWORD_LENGTH;
  if (opts.minLength !== undefined && opts.minLength > 0) len = Math.max(len, opts.minLength);
  if (opts.maxLength !== undefined && opts.maxLength > 0) len = Math.min(len, opts.maxLength);
  if (!Number.isInteger(len) || len < 1) {
    throw new Error(`Invalid password length ${len}`);
  }
  return len;
}

/**
 * Generate a random password with at least one character from each enabled
 * class (when the length allows it), shuffled so the guaranteed characters
 * don't sit at predictable positions.
 */
export function generatePassword(opts: GeneratePasswordOptions = {}): string {
  const len = resolvePasswordLength(opts);
  const classes = [UPPER, LOWER, DIGITS];
  if (opts.symbols ?? true) classes.push(SYMBOLS);
  const pool = classes.join("");

  const chars: string[] = [];
  if (len >= classes.length) {
    for (const c of classes) chars.push(c[randomInt(c.length)]);
  }
  while (chars.length < len) chars.push(pool[randomInt(pool.length)]);

  // Fisher–Yates shuffle.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
