import { db } from '../db';

export type SettingKey =
  | 'loan_eligibility_months' | 'loan_annual_rate' | 'loan_min_amount' | 'loan_max_amount'
  | 'loan_min_tenure' | 'loan_max_tenure' | 'allow_partial_repayment' | 'repayment_max_attempts'
  | 'loan_reminder_days' | 'due_reminder_days' | 'loan_grace_days';

export const listSettings = () => db.query('SELECT setting_key AS `key`, setting_value AS value, description, updated_at AS updatedAt FROM settings ORDER BY setting_key');

export async function getSetting(key: SettingKey, d = db): Promise<string> {
  const r = await d.one<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  if (!r) throw new Error(`Missing setting ${key}`);
  return r.setting_value;
}
export const getNumber = async (key: SettingKey, d = db) => Number(await getSetting(key, d));
export const getBool = async (key: SettingKey, d = db) => (await getSetting(key, d)) === 'true';

const NUMERIC: SettingKey[] = ['loan_eligibility_months', 'loan_annual_rate', 'loan_min_amount', 'loan_max_amount', 'loan_min_tenure', 'loan_max_tenure', 'repayment_max_attempts', 'loan_reminder_days', 'due_reminder_days', 'loan_grace_days'];
export function validateSetting(key: string, value: string): string | null {
  if (key === 'allow_partial_repayment') return value === 'true' || value === 'false' ? null : 'Must be true or false';
  if (NUMERIC.includes(key as SettingKey)) return Number.isFinite(Number(value)) && Number(value) >= 0 ? null : 'Must be a non-negative number';
  return 'Unknown setting';
}
