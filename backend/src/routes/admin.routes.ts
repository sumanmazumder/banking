import { Router } from 'express';
import * as c from '../controllers/admin.controller';
import { authenticate, requireRole } from '../middleware/auth';
import { csrfGuard } from '../middleware/security';
import { validate } from '../middleware/validate';
import { reasonSchema } from '../utils/validators';

const r = Router();
r.use(authenticate, requireRole('super_admin', 'admin'));

r.get('/users/:publicId/sessions', c.userSessions);
r.post('/users/:publicId/sessions/revoke-all', csrfGuard, validate(reasonSchema), c.revokeAllForUser);
r.delete('/sessions/:sid', csrfGuard, validate(reasonSchema), c.revokeSessionById);

export default r;
