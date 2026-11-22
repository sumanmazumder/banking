// All money maths is done in integer paise (never floats). DB columns are DECIMAL(14,2) and arrive as strings.
export const toPaise = (v: string | number | null | undefined): number => Math.round(Number(v ?? 0) * 100);
export const fromPaise = (p: number): string => (p / 100).toFixed(2);
export const addMoney = (...v: Array<string | number>) => fromPaise(v.reduce<number>((a, b) => a + toPaise(b), 0));

/** Equal monthly instalment for a reducing-balance loan. Returns paise. */
export function emiPaise(principalPaise: number, annualRatePct: number, months: number): number {
  const r = annualRatePct / 12 / 100;
  if (r === 0) return Math.round(principalPaise / months);
  const f = Math.pow(1 + r, months);
  return Math.round((principalPaise * r * f) / (f - 1));
}
