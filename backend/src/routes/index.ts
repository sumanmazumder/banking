import { Router } from 'express';
import { health } from '../controllers/health.controller';
import authRoutes from './auth.routes';
import sessionRoutes from './session.routes';
import adminRoutes from './admin.routes';

// Mounted at /api. Frontend: BASE_URL + these paths.
const api = Router();
api.get('/health', health);
api.use('/auth', authRoutes);
api.use('/sessions', sessionRoutes);
api.use('/admin', adminRoutes);

export default api;
