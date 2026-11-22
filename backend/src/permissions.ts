import { requireRole } from './middleware/auth';

// Least-privilege RBAC (SRS section 4). Every staff route declares the permission it needs; the check
// runs on the API for every request, independent of what the UI shows.
const ALL_STAFF = ['super_admin', 'admin', 'finance_officer', 'auditor'];

export const PERMS = {
  'customers.read': ALL_STAFF,
  'kyc.review': ['super_admin', 'admin'],
  'contribution.assign': ['super_admin', 'admin'],
  'customers.manage': ['super_admin', 'admin'], // suspend / reactivate
  'sessions.revoke': ['super_admin', 'admin'],
  'payments.read': ALL_STAFF,
  'payments.record': ['super_admin', 'admin', 'finance_officer'],
  'payments.reconcile': ['super_admin', 'finance_officer'],
  'ledger.read': ALL_STAFF,
  'adjust.request': ['super_admin', 'admin', 'finance_officer'],
  'adjust.approve': ['super_admin', 'finance_officer'],
  'latefee.read': ALL_STAFF,
  'latefee.configure': ['super_admin'],
  'latefee.waive': ['super_admin', 'admin'],
  'interest.read': ALL_STAFF,
  'interest.configure': ['super_admin'],
  'interest.run': ['super_admin', 'finance_officer'],
  'loans.read': ALL_STAFF,
  'loans.review': ['super_admin', 'admin'],
  'loans.disburse': ['super_admin', 'admin', 'finance_officer'],
  'reports.read': ALL_STAFF,
  'audit.read': ['super_admin', 'auditor'],
  'settings.read': ALL_STAFF,
  'settings.write': ['super_admin'],
  'staff.manage': ['super_admin'],
  'support.manage': ['super_admin', 'admin'],
  'jobs.run': ['super_admin'],
} as const;

export type Perm = keyof typeof PERMS;
export const can = (p: Perm) => requireRole(...PERMS[p]);
export const permsFor = (role: string): Perm[] =>
  (Object.keys(PERMS) as Perm[]).filter((p) => (PERMS[p] as readonly string[]).includes(role));
