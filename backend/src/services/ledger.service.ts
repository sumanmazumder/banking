import { v4 as uuid } from 'uuid';
import { db, type Db } from '../db';
import { fromPaise, toPaise } from '../utils/money';

export type TxType =
  | 'opening_deposit' | 'contribution' | 'interest_credit' | 'late_fee'
  | 'loan_disbursement' | 'loan_repayment' | 'reversal' | 'adjustment';

export interface PostInput {
  reference?: string;
  accountId: number;
  loanId?: number | null;
  ledger?: 'savings' | 'loan';
  type: TxType;
  direction: 'debit' | 'credit';
  amount: string; // DECIMAL string, > 0
  postingDate: string; // YYYY-MM-DD business date
  description: string;
  paymentId?: number | null;
  dueId?: number | null;
  reversalOf?: number | null;
  groupRef?: string | null;
  createdBy?: number | null;
}

/** The ONLY write path into the ledger. Rows are never updated or deleted - corrections are new linked rows. */
export async function post(tx: Db, i: PostInput): Promise<number> {
  if (toPaise(i.amount) <= 0) throw new Error('Ledger amount must be positive');
  const r = await tx.execute(
    `INSERT INTO ledger_transactions
      (reference, account_id, loan_id, ledger, tx_type, direction, amount, status, posting_date, description,
       payment_id, due_id, reversal_of, group_ref, created_by)
     VALUES (?,?,?,?,?,?,?, 'posted', ?,?,?,?,?,?,?)`,
    [
      i.reference ?? `TX-${uuid()}`, i.accountId, i.loanId ?? null, i.ledger ?? 'savings', i.type, i.direction, i.amount,
      i.postingDate, i.description, i.paymentId ?? null, i.dueId ?? null, i.reversalOf ?? null, i.groupRef ?? null, i.createdBy ?? null,
    ]
  );
  return r.insertId;
}

/** Savings balance, derived from posted ledger rows (never stored). Returns paise. */
export async function savingsBalancePaise(d: Db, accountId: number, asOf?: string, excludeTypes: TxType[] = []): Promise<number> {
  const params: (string | number)[] = [accountId];
  let extra = '';
  if (asOf) {
    extra += ' AND posting_date <= ?';
    params.push(asOf);
  }
  if (excludeTypes.length) {
    extra += ` AND tx_type NOT IN (${excludeTypes.map(() => '?').join(',')})`;
    params.push(...excludeTypes);
  }
  const r = await d.one<{ b: string | null }>(
    `SELECT SUM(IF(direction='credit', amount, -amount)) b FROM ledger_transactions
      WHERE account_id = ? AND ledger = 'savings' AND status = 'posted'${extra}`,
    params
  );
  return toPaise(r?.b ?? 0);
}
export const savingsBalance = async (accountId: number, d: Db = db) => fromPaise(await savingsBalancePaise(d, accountId));

export interface PassbookRow {
  id: number;
  date: string;
  reference: string;
  type: string;
  description: string;
  debit: string | null;
  credit: string | null;
  balance: string;
  status: string;
}

/** Passbook for a date range. The running balance starts from everything posted before `from` (FR-PASS-02/05). */
export async function passbook(accountId: number, from?: string, to?: string) {
  const opening = from
    ? await db.one<{ b: string | null }>(
        `SELECT SUM(IF(direction='credit', amount, -amount)) b FROM ledger_transactions
          WHERE account_id=? AND ledger='savings' AND status='posted' AND posting_date < ?`,
        [accountId, from]
      )
    : undefined;
  const params: (string | number)[] = [accountId];
  let where = "account_id = ? AND ledger = 'savings' AND status = 'posted'";
  if (from) {
    where += ' AND posting_date >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND posting_date <= ?';
    params.push(to);
  }
  const rows = await db.query<any>(
    `SELECT id, posting_date, reference, tx_type, description, direction, amount, status
       FROM ledger_transactions WHERE ${where} ORDER BY posting_date, id LIMIT 5000`,
    params
  );
  let run = toPaise(opening?.b ?? 0);
  const openingBalance = fromPaise(run);
  const out: PassbookRow[] = rows.map((r) => {
    run += r.direction === 'credit' ? toPaise(r.amount) : -toPaise(r.amount);
    return {
      id: r.id, date: r.posting_date, reference: r.reference, type: r.tx_type, description: r.description,
      debit: r.direction === 'debit' ? r.amount : null, credit: r.direction === 'credit' ? r.amount : null,
      balance: fromPaise(run), status: r.status,
    };
  });
  return { openingBalance, closingBalance: fromPaise(run), rows: out };
}

export const loanLedger = (loanId: number) =>
  db.query(
    `SELECT id, posting_date AS date, reference, tx_type AS type, description, direction, amount
       FROM ledger_transactions WHERE loan_id = ? AND ledger = 'loan' ORDER BY posting_date, id`,
    [loanId]
  );
