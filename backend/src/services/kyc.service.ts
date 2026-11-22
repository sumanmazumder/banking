import { db, withTx } from '../db';
import { decrypt, encrypt } from '../utils/crypto';
import { ApiError, type ReqCtx } from '../utils/http';
import { audit } from './audit.service';
import { notify } from './notification.service';

export interface KycInput {
  documentType: 'aadhaar' | 'pan' | 'passport' | 'voter_id' | 'driving_licence';
  documentNumber: string;
  address: string;
  dateOfBirth: string; // YYYY-MM-DD
}

const FORMATS: Record<KycInput['documentType'], RegExp> = {
  aadhaar: /^\d{12}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  passport: /^[A-Z]\d{7}$/,
  voter_id: /^[A-Z]{3}\d{7}$/,
  driving_licence: /^[A-Z]{2}[0-9A-Z]{8,14}$/,
};

export const validateDocumentNumber = (t: KycInput['documentType'], n: string) => FORMATS[t].test(n);

const isAdult = (dob: string) => {
  const d = new Date(`${dob}T00:00:00Z`);
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() - 18);
  return d <= limit;
};

export async function submitKyc(userId: number, i: KycInput, ctx: ReqCtx) {
  const number = i.documentNumber.replace(/\s+/g, '').toUpperCase();
  if (!validateDocumentNumber(i.documentType, number)) {
    throw new ApiError(400, `Invalid ${i.documentType.replace('_', ' ')} number format`, 'VALIDATION');
  }
  if (!isAdult(i.dateOfBirth)) throw new ApiError(400, 'You must be at least 18 years old', 'VALIDATION');

  await withTx(async (tx) => {
    const u = await tx.one<{ status: string }>('SELECT status FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!u || !['draft', 'kyc_pending', 'rejected'].includes(u.status)) {
      throw new ApiError(409, 'KYC cannot be submitted in the current account status', 'KYC_NOT_ALLOWED');
    }
    await tx.execute(
      'INSERT INTO kyc_records (user_id, document_type, document_number_enc, document_last4) VALUES (?,?,?,?)',
      [userId, i.documentType, encrypt(number), number.slice(-4)]
    );
    await tx.execute('UPDATE customer_profiles SET address = ?, date_of_birth = ?, kyc_status = ? WHERE user_id = ?', [
      i.address, i.dateOfBirth, 'under_review', userId,
    ]);
    await tx.execute("UPDATE users SET status = 'under_review' WHERE id = ?", [userId]);
    await notify(userId, 'kyc.submitted', 'KYC submitted', 'We received your KYC details. You will be notified once they are reviewed.', undefined, tx);
  });
  await audit(ctx, { action: 'kyc.submit', entity: 'user', entityId: userId, actor: { userId, role: 'customer' } });
}

export const latestKyc = (userId: number) =>
  db.one<any>(
    `SELECT id, document_type AS documentType, document_last4 AS last4, verification_status AS status,
            review_note AS note, reviewed_at AS reviewedAt, created_at AS submittedAt
       FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId]
  );

export async function kycQueue(status: string, page: number, pageSize: number) {
  const rows = await db.query<any>(
    `SELECT k.id, k.document_type AS documentType, k.document_last4 AS last4, k.verification_status AS status, k.created_at AS submittedAt,
            u.public_id AS userId, u.full_name AS fullName, u.email
       FROM kyc_records k JOIN users u ON u.id = k.user_id
      WHERE k.verification_status = ? ORDER BY k.id DESC LIMIT ? OFFSET ?`,
    [status, pageSize, (page - 1) * pageSize]
  );
  const total = Number((await db.one<{ c: number }>('SELECT COUNT(*) c FROM kyc_records WHERE verification_status = ?', [status]))!.c);
  return { rows, total };
}

/** Reviewer sees the full document number; every view is audited (FR-CUS-03: access-controlled sensitive data). */
export async function kycDetail(id: number, actor: { userId: number; role: string; sid: string }, ctx: ReqCtx) {
  const k = await db.one<any>(
    `SELECT k.*, u.public_id AS userPublicId, u.full_name, u.email, u.mobile, p.address, p.date_of_birth
       FROM kyc_records k JOIN users u ON u.id = k.user_id JOIN customer_profiles p ON p.user_id = u.id WHERE k.id = ?`,
    [id]
  );
  if (!k) throw new ApiError(404, 'KYC record not found', 'NOT_FOUND');
  await audit(ctx, { action: 'kyc.document_viewed', entity: 'kyc', entityId: id, actor });
  return {
    id: k.id, status: k.verification_status, documentType: k.document_type, documentNumber: decrypt(k.document_number_enc),
    userId: k.userPublicId, fullName: k.full_name, email: k.email, mobile: k.mobile, address: k.address, dateOfBirth: k.date_of_birth,
    note: k.review_note, submittedAt: k.created_at, reviewedAt: k.reviewed_at,
  };
}

export async function reviewKyc(
  id: number, decision: 'approved' | 'rejected' | 'more_info', note: string,
  actor: { userId: number; role: string; sid: string }, ctx: ReqCtx
) {
  await withTx(async (tx) => {
    const k = await tx.one<{ user_id: number; verification_status: string }>('SELECT user_id, verification_status FROM kyc_records WHERE id = ? FOR UPDATE', [id]);
    if (!k) throw new ApiError(404, 'KYC record not found', 'NOT_FOUND');
    if (k.verification_status !== 'pending') throw new ApiError(409, 'This KYC record was already reviewed', 'ALREADY_REVIEWED');
    await tx.execute(
      'UPDATE kyc_records SET verification_status = ?, reviewer_id = ?, reviewed_at = UTC_TIMESTAMP(), review_note = ? WHERE id = ?',
      [decision, actor.userId, note, id]
    );
    // approved -> profile approved, user stays 'under_review' until the opening payment activates the account.
    const profileStatus = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'pending';
    await tx.execute('UPDATE customer_profiles SET kyc_status = ? WHERE user_id = ?', [profileStatus, k.user_id]);
    if (decision === 'rejected') await tx.execute("UPDATE users SET status = 'rejected' WHERE id = ?", [k.user_id]);
    if (decision === 'more_info') await tx.execute("UPDATE users SET status = 'kyc_pending' WHERE id = ?", [k.user_id]);
    const msg = {
      approved: 'Your KYC was approved. You can now choose an opening amount and activate your account.',
      rejected: `Your KYC was rejected. Reason: ${note}. You may submit corrected details.`,
      more_info: `We need more information for your KYC: ${note}. Please resubmit.`,
    }[decision];
    await notify(k.user_id, `kyc.${decision}`, `KYC ${decision.replace('_', ' ')}`, msg, undefined, tx);
  });
  await audit(ctx, { action: `kyc.${decision}`, entity: 'kyc', entityId: id, reason: note, actor });
}
