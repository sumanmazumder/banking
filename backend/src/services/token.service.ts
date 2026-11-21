import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import config from '../config';

export interface AccessClaims extends JwtPayload {
  sid: string;
  role: string;
  sub: string;
  jti: string;
  exp: number;
}

// Access token claims per FR-CUS-03: sub, sid, role, jti, iat, exp
export function signAccessToken(p: { userId: number; sessionId: string; role: string }) {
  const jti = uuid();
  const token = jwt.sign({ sid: p.sessionId, role: p.role }, config.jwtPrivateKey, {
    algorithm: config.JWT_ALGORITHM,
    subject: String(p.userId),
    jwtid: jti,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn: config.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  });
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.jwtPublicKey, {
    algorithms: [config.JWT_ALGORITHM],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  }) as AccessClaims;
}
