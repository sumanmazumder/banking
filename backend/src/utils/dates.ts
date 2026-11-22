import config from '../config';

// Dates are 'YYYY-MM-DD' strings in the business timezone (Asia/Kolkata). Arithmetic runs in UTC on those
// calendar dates, which has no DST so it is exact.
export const todayBusiness = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => fmt(new Date(toUtc(d).getTime() + n * 86400000));
export const daysBetween = (from: string, to: string): number => Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86400000);
export const periodOf = (d: string): string => d.slice(0, 7);
export const lastDayOfMonth = (period: string): string => {
  const [y, m] = period.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m, 0)));
};
export const addMonthsToPeriod = (period: string, n: number): string => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** Date for `day` (1..28) in the given period. */
export const dateInPeriod = (period: string, day: number): string => `${period}-${String(day).padStart(2, '0')}`;
export const addMonths = (d: string, n: number): string => {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), Math.min(day, last))));
};
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
