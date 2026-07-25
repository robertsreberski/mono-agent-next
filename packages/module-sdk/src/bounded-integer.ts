export function boundedInteger(
  value: number, name: string, minimum: number, maximum: number,
  error: (message: string) => Error,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
