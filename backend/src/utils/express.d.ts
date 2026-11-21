export interface AuthContext {
  userId: number;
  sid: string;
  jti: string;
  exp: number;
  role: string;
  status: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      maskedIp?: string | null;
    }
  }
}
