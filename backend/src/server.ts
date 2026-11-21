import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import config, { ROOT } from './config';
import { pool } from './db';
import routes from './routes';
import { attachRequestMeta } from './middleware/security';
import { errorHandler, notFound } from './middleware/error';
import { cleanupExpired } from './services/session.service';

const app = express();
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.use(morgan(config.isProd ? 'combined' : 'dev'));
// NOTE: payment webhooks (Phase 2) need the RAW body for signature verification - mount them BEFORE express.json().
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser(config.COOKIE_SECRET));
app.use(attachRequestMeta);

// public/ = non-sensitive static files. uploads/ (KYC documents) is deliberately NOT served statically.
app.use('/public', express.static(path.join(ROOT, 'public')));

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.PORT, () =>
  console.log(`API listening on http://localhost:${config.PORT} (${config.APP_ENV})`)
);
setInterval(() => cleanupExpired().catch((e) => console.error('cleanup failed', e.message)), 60 * 60 * 1000).unref();

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
