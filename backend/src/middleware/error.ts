import type { NextFunction, Request, Response } from 'express';
import config from '../config';
import { ApiError } from '../utils/http';

export const notFound = (_req: Request, _res: Response, next: NextFunction) =>
  next(new ApiError(404, 'Route not found', 'NOT_FOUND'));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (err: Error & Partial<ApiError>, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 && config.isProd ? 'Internal server error' : err.message;
  res.status(status).json({
    status: 0,
    message,
    error: { code: err.code || 'INTERNAL_ERROR', message, ...(err.details ? { details: err.details } : {}) },
  });
};
