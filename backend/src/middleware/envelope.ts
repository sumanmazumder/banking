import type { NextFunction, Request, Response } from 'express';

// One response shape for EVERY successful API call, whatever the method:
//   { status: 1, data: <payload | null>, message: '<text>' }
// Errors use  { status: 0, message, error: { code, message, details? } }  (see middleware/error.ts).
// Controllers just call res.json(payload) (optionally with a `message` field); this wraps it in one place so
// no controller can drift from the contract.
const DEFAULT_MESSAGE: Record<string, string> = {
  GET: 'Fetched successfully',
  POST: 'Saved successfully',
  PUT: 'Updated successfully',
  PATCH: 'Updated successfully',
  DELETE: 'Deleted successfully',
};

export const responseEnvelope = (req: Request, res: Response, next: NextFunction) => {
  const send = res.json.bind(res);
  res.json = (body?: any) => {
    if (res.statusCode >= 400 || (body && typeof body === 'object' && 'status' in body && 'data' in body)) return send(body); // errors / already wrapped
    const { message, ...rest } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const hasData = Object.keys(rest).length > 0;
    return send({ status: 1, data: hasData ? rest : null, message: message ?? DEFAULT_MESSAGE[req.method] ?? 'Success' });
  };
  next();
};
