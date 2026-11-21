import type { Request, Response } from 'express';
import { pool } from '../db';

export const health = async (_req: Request, res: Response) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
};
