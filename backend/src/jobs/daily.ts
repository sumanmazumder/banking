import { db } from '../db';
import config from '../config';
import { addMonthsToPeriod, periodOf, todayBusiness } from '../utils/dates';
import { assessLateFees, dueReminders, generateDues, refreshDueStatuses } from '../services/billing.service';
import { postInterestForPeriod } from '../services/interest.service';
import { advanceBalanceCheck, applyLoanLateFees, runAutoRepayments, updateScheduleStatuses } from '../services/loan.service';
import { deliverQueued } from '../services/notification.service';
import { cleanupExpired } from '../services/session.service';

let running = false;

/**
 * The daily batch (SRS 5.10 / section 9 "background processing"). Every step is idempotent, so running it twice
 * - or from two app instances - cannot create duplicate dues, fees, interest or debits.
 */
export async function runDailyJobs(asOf?: string, source = 'scheduler') {
  if (running) return { skipped: true as const, reason: 'A run is already in progress' };
  running = true;
  const today = asOf ?? todayBusiness();
  const run = await db.execute('INSERT INTO job_runs (run_date, trigger_src) VALUES (?, ?)', [today, source]);
  const summary: Record<string, unknown> = {};
  try {
    summary.duesCreated = await generateDues(today);
    summary.duesMarkedOverdue = await refreshDueStatuses(today);
    summary.dueReminders = await dueReminders(today);
    summary.lateFeesAssessed = await assessLateFees(today);

    // Interest for the previous (completed) month. No-op unless a super admin has approved a rule.
    const prev = addMonthsToPeriod(periodOf(today), -1);
    const interest = await postInterestForPeriod(prev, { maskedIp: null, userAgent: 'job' }).catch((e) => ({ error: (e as Error).message }));
    summary.interest = interest;

    summary.loanSchedulesOverdue = await updateScheduleStatuses(today);
    summary.loanLateFees = await applyLoanLateFees(today);
    summary.balanceWarnings = await advanceBalanceCheck(today);
    summary.autoRepayments = await runAutoRepayments(today);

    summary.sessionsCleaned = await cleanupExpired().catch(() => 0);
    await db.execute("UPDATE job_runs SET status = 'ok', finished_at = UTC_TIMESTAMP(), summary = ? WHERE id = ?", [JSON.stringify(summary), run.insertId]);
    return { skipped: false as const, runDate: today, summary };
  } catch (err) {
    await db.execute("UPDATE job_runs SET status = 'error', finished_at = UTC_TIMESTAMP(), summary = ? WHERE id = ?", [
      JSON.stringify({ ...summary, error: (err as Error).message }), run.insertId,
    ]);
    console.error('Daily job failed:', err);
    throw err;
  } finally {
    running = false;
  }
}

/** Starts the in-process schedulers. For multi-instance production deploys, run this in ONE worker (or use a queue). */
export function startSchedulers() {
  // Email/notification delivery with retry, every 30 seconds.
  setInterval(() => deliverQueued().catch((e) => console.error('notification delivery failed:', e.message)), 30_000).unref();

  // Daily batch: checked hourly, runs once per business day. The idempotent steps make a duplicate harmless.
  const tick = async () => {
    try {
      const today = todayBusiness();
      const done = await db.one("SELECT id FROM job_runs WHERE run_date = ? AND status = 'ok' AND trigger_src = 'scheduler' LIMIT 1", [today]);
      if (!done) await runDailyJobs(undefined, 'scheduler');
    } catch (e) {
      console.error('scheduler tick failed:', (e as Error).message);
    }
  };
  setTimeout(tick, 15_000).unref(); // shortly after boot, then hourly
  setInterval(tick, 60 * 60 * 1000).unref();
  console.log(`Schedulers started (business timezone ${config.BUSINESS_TIMEZONE}).`);
}

export const recentJobRuns = () =>
  db.query('SELECT id, run_date AS runDate, started_at AS startedAt, finished_at AS finishedAt, status, summary, trigger_src AS source FROM job_runs ORDER BY id DESC LIMIT 30');
