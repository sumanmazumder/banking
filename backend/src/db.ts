import mysql, { ResultSetHeader, type PoolConnection } from 'mysql2/promise';
import config from './config';

// Money columns are DECIMAL; mysql2 returns them as strings (decimalNumbers:false) to avoid float errors.
export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: false,
  timezone: 'Z', // store/read everything as UTC
  dateStrings: ['DATE'], // DATE columns (due dates, posting dates) come back as 'YYYY-MM-DD', no timezone drift
});

type Param = string | number | boolean | Date | null | Array<string | number>;

/** SELECT returning rows. */
export async function query<T = any>(sql: string, params: Param[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

/** SELECT returning the first row or undefined. */
export async function one<T = any>(sql: string, params: Param[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

/** INSERT / UPDATE / DELETE. */
export async function execute(sql: string, params: Param[] = []): Promise<ResultSetHeader> {
  const [res] = await pool.query(sql, params);
  return res as ResultSetHeader;
}

/** A query handle: either the pool or one connection inside a transaction. */
export interface Db {
  query<T = any>(sql: string, params?: Param[]): Promise<T[]>;
  one<T = any>(sql: string, params?: Param[]): Promise<T | undefined>;
  execute(sql: string, params?: Param[]): Promise<ResultSetHeader>;
}

const wrap = (c: { query: (sql: string, params?: any) => Promise<any> }): Db => ({
  query: async (sql, params = []) => (await c.query(sql, params))[0],
  one: async (sql, params = []) => (await c.query(sql, params))[0][0],
  execute: async (sql, params = []) => (await c.query(sql, params))[0] as ResultSetHeader,
});

export const db: Db = wrap(pool);

/** Runs fn inside a transaction; commits on success, rolls back on any error. Use `FOR UPDATE` for row locks. */
export async function withTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(wrap(conn));
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

export default pool;
