const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/**
 * Minimal ULID-style id: a millisecond timestamp encoded as 10 Crockford base32 chars
 * (50-bit capacity, monotonically sortable) + a 16-char random suffix. Injectable for tests.
 */
export function createIdFactory(options: { clock?: () => Date; random?: () => number } = {}): () => string {
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  return () => {
    let time = clock().getTime();
    const timeChars: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      timeChars.unshift(ENCODING[time % 32] ?? "0");
      time = Math.floor(time / 32);
    }
    let suffix = "";
    for (let i = 0; i < 16; i += 1) {
      suffix += ENCODING[Math.floor(random() * 32)] ?? "0";
    }
    return timeChars.join("") + suffix;
  };
}
