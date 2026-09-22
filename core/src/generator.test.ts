import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PASSWORD_LENGTH,
  generatePassword,
  randomInt,
  resolvePasswordLength,
} from "./generator.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("randomInt", () => {
  it("rejects draws at or above the largest multiple of n", () => {
    // For n=3 the limit is 2^32 - 1, so 0xFFFFFFFF must be redrawn.
    const draws = [0xffffffff, 5];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(buf: T) => {
      (buf as unknown as Uint32Array)[0] = draws.shift()!;
      return buf;
    });
    expect(randomInt(3)).toBe(2);
    expect(draws).toHaveLength(0);
  });

  it("is roughly uniform", () => {
    const n = 62;
    const perBucket = 1000;
    const counts = new Array(n).fill(0);
    for (let i = 0; i < n * perBucket; i++) counts[randomInt(n)]++;
    // σ ≈ 31 per bucket; ±200 is > 6σ, so this only fails on real bias.
    for (const c of counts) {
      expect(c).toBeGreaterThan(perBucket - 200);
      expect(c).toBeLessThan(perBucket + 200);
    }
  });

  it("rejects invalid bounds", () => {
    expect(() => randomInt(0)).toThrow();
    expect(() => randomInt(1.5)).toThrow();
  });
});

describe("resolvePasswordLength", () => {
  it("defaults to 20", () => {
    expect(resolvePasswordLength()).toBe(DEFAULT_PASSWORD_LENGTH);
  });

  it("clamps into the field's minlength/maxlength", () => {
    expect(resolvePasswordLength({ maxLength: 16 })).toBe(16);
    expect(resolvePasswordLength({ minLength: 32 })).toBe(32);
    expect(resolvePasswordLength({ minLength: 8, maxLength: 64 })).toBe(20);
  });

  it("ignores unset (-1 / 0) constraints", () => {
    expect(resolvePasswordLength({ minLength: -1, maxLength: -1 })).toBe(20);
    expect(resolvePasswordLength({ minLength: 0, maxLength: 0 })).toBe(20);
  });
});

describe("generatePassword", () => {
  it("has the requested length and every character class", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("omits symbols when asked", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword({ symbols: false })).toMatch(/^[A-Za-z0-9]{20}$/);
    }
  });

  it("respects maxlength", () => {
    expect(generatePassword({ maxLength: 12 })).toHaveLength(12);
  });

  it("still fills very short capped fields", () => {
    expect(generatePassword({ maxLength: 3 })).toHaveLength(3);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });
});
