// src/index.js
// SNEHAMVERSE Voice Agent v2.1 — Production Server
// FIX: Redis pre-connected before server accepts calls

require('dotenv').config();
require('./utils/checkEnv');

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const callRoutes             = require('./routes/callRoutes');
const { setupStreamHandler } = require('./handlers/streamHandler');
const { initSheetsHeaders }  = require('./services/notificationService');
const { connectRedis }       = require('./services/sessionManager');
const logger = require('./utils/logger');

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ── Security ──────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  'Too many requests',
  skip: (req) => req.path.startsWith('/call/stream'),
});
app.use(limiter);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── WebSocket for Twilio Media Streams ────────────────────────
const wss = new WebSocket.Server({
  server,
  path: '/call/stream',
  verifyClient: ({ req }, cb) => {
    if (process.env.NODE_ENV === 'production') {
      const ua = req.headers['user-agent'] || '';
      if (!ua.includes('TwilioProxy') && !ua.includes('twilio')) {
        logger.warn('Rejected non-Twilio WebSocket', { ua });
        cb(false, 403, 'Forbidden');
        return;
      }
    }
    cb(true);
  }
});

setupStreamHandler(wss);

// ── Routes ────────────────────────────────────────────────────
app.use('/call', callRoutes);

app.get('/', (req, res) => {
  res.json({
    status:    'ok',
    service:   'SNEHAMVERSE Voice Agent',
    version:   '2.1.0',
    business:  process.env.BUSINESS_NAME || 'Not configured',
    languages: ['Hindi', 'Telugu', 'English'],
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  logger.error('Unhandled express error', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start — Redis first, then server ─────────────────────────
const PORT = (process.env.PORT) || 3000;

async function start() {
  try {
    // FIX: connect Redis BEFORE accepting any calls
    logger.info('Connecting to Redis...');
    try {
  await connectRedis();
  logger.info('Redis connected');
} catch (err) {
  logger.warn('Redis not available — continuing without it');
}

    server.listen(PORT, '0.0.0.0', async () => {
      logger.info(`✅ SNEHAMVERSE Voice Agent v2.1 running on port ${PORT}`);
      logger.info(`   Business : ${process.env.BUSINESS_NAME}`);
      logger.info(`   Type     : ${process.env.BUSINESS_TYPE}`);
      logger.info(`   Webhook  : ${process.env.BASE_URL}/call/incoming`);

      // Google Sheets headers — non-blocking, failure is OK
      try {
        await initSheetsHeaders();
      } catch {
        logger.warn('Google Sheets unavailable — call logging disabled');
      }
    });

  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

start();

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  server.close(() => { logger.info('Server closed'); process.exit(0); });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

module.exports = { app, server };
