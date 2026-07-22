import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { clampUtf8Bytes } from '../text.js';

describe('clampUtf8Bytes', () => {
  it.each([-1, -Infinity, Infinity, Number.NaN, 1.5])('rejects invalid byte budget %s', (maxBytes) => {
    expect(() => clampUtf8Bytes('text', maxBytes)).toThrow(RangeError);
  });

  it('honors zero and exact ASCII boundaries', () => {
    expect(clampUtf8Bytes('ABC', 0)).toBe('');
    expect(clampUtf8Bytes('ABC', 1)).toBe('A');
    expect(clampUtf8Bytes('ABC', 3)).toBe('ABC');
    expect(clampUtf8Bytes('ABC', 4)).toBe('ABC');
  });

  it('preserves a leading U+FEFF in every complete truncated prefix', () => {
    const value = '\uFEFFA🧠Z';

    expect(clampUtf8Bytes(value, 2)).toBe('');
    expect(clampUtf8Bytes(value, 3)).toBe('\uFEFF');
    expect(clampUtf8Bytes(value, 4)).toBe('\uFEFFA');
    expect(clampUtf8Bytes(value, 5)).toBe('\uFEFFA');
    expect(clampUtf8Bytes(value, 8)).toBe('\uFEFFA🧠');
  });

  it.each([
    ['2-byte', 'é'],
    ['3-byte', '€'],
    ['4-byte', '🧠'],
  ] as const)('drops every incomplete interior cut of a %s code point', (_label, value) => {
    const byteLength = Buffer.byteLength(value, 'utf8');
    for (let maxBytes = 0; maxBytes < byteLength; maxBytes += 1) {
      expect(clampUtf8Bytes(value, maxBytes)).toBe('');
    }
    expect(clampUtf8Bytes(value, byteLength)).toBe(value);
  });

  it('returns the longest well-formed prefix for every representative byte budget', () => {
    const value = 'Aé€🧠Z';
    const totalBytes = Buffer.byteLength(value, 'utf8');

    for (let maxBytes = 0; maxBytes <= totalBytes + 1; maxBytes += 1) {
      const clamped = clampUtf8Bytes(value, maxBytes);
      expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(value.startsWith(clamped)).toBe(true);
      expect(clamped).not.toContain('�');
      expect(clamped).not.toMatch(/\p{Cs}/u);

      for (const codePoint of Array.from(value)) {
        const extended = `${clamped}${codePoint}`;
        if (value.startsWith(extended)) {
          expect(Buffer.byteLength(extended, 'utf8')).toBeGreaterThan(maxBytes);
          break;
        }
      }
    }
  });
});
