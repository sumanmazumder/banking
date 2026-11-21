import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from '../utils/http';

export const validate = (schema: ZodType) => (req: Request, _res: Response, next: NextFunction) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    const err = new ApiError(400, 'Validation failed', 'VALIDATION');
    err.details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw err;
  }
  req.body = r.data;
  next();
};
