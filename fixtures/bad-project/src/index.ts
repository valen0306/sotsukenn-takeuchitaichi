// Intentional type error for smoke testing
const value: number = "oops";

export function brokenAdd(a: number, b: number): number {
  return a + (value as unknown as number) + b;
}

