import { Router } from 'express';
import * as c from '../controllers/session.controller';
import { authenticate } from '../middleware/auth';
import { csrfGuard } from '../middleware/security';

const r = Router();
r.use(authenticate);

r.get('/', c.list);
r.post('/logout-others', csrfGuard, c.logoutOthers);
r.delete('/:sid', csrfGuard, c.revokeOne);

export default r;
