import mysql, { ResultSetHeader } from 'mysql2/promise';
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

export default pool;
