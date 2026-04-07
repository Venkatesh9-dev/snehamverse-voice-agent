// src/services/sessionManager.js
// Manages per-call state in Redis — conversation history, language, booking data

const Redis  = require('ioredis');
const logger = require('../utils/logger');

const SESSION_TTL   = 3600;  // 1 hour active session
const COMPLETED_TTL = 86400; // 24 hours after call ends

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
      retryStrategy: (times) => {
        if (times > 10) return null;
        return Math.min(times * 200, 3000);
      },
      maxRetriesPerRequest: 3,
      lazyConnect: false,          // FIX: connect eagerly on startup
      enableOfflineQueue: true,    // FIX: queue commands while connecting
    });
    redis.on('error',   (err) => logger.error('Redis error', { error: err.message }));
    redis.on('connect', ()    => logger.info('Redis connected'));
    redis.on('close',   ()    => logger.warn('Redis connection closed'));
  }
  return redis;
}

// Call this at server startup to pre-warm the connection
async function connectRedis() {
  try {
    await getRedis().ping();
    logger.info('Redis pre-connection successful');
  } catch (err) {
    logger.error('Redis pre-connection failed', { error: err.message });
    throw err;
  }
}

async function createSession(callSid, callerPhone) {
  const session = {
    callSid,
    callerPhone,
    language:          'english',
    detectedLanguage:  null,
    messages:          [],
    bookingData:       {},
    startTime:         Date.now(),
    outcome:           'in_progress',
    transferRequested: false,
    idleWarningsSent:  0,
  };
  await getRedis().setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(session));
  logger.info('Session created', { callSid });
  return session;
}

async function getSession(callSid) {
  try {
    const data = await getRedis().get(`call:${callSid}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('getSession error', { error: err.message, callSid });
    return null;
  }
}

async function updateSession(callSid, updates) {
  try {
    const session = await getSession(callSid);
    if (!session) return null;
    const updated = { ...session, ...updates };
    await getRedis().setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(updated));
    return updated;
  } catch (err) {
    logger.error('updateSession error', { error: err.message, callSid });
    return null;
  }
}

async function addMessage(callSid, role, content) {
  try {
    const session = await getSession(callSid);
    if (!session) return null;
    session.messages.push({ role, content });
    // Cap at 20 messages to control Redis memory and LLM token cost
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }
    await getRedis().setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(session));
    return session;
  } catch (err) {
    logger.error('addMessage error', { error: err.message, callSid });
    return null;
  }
}

async function endSession(callSid, outcome = 'completed') {
  try {
    const session = await getSession(callSid);
    if (!session) return null;
    const duration     = Math.round((Date.now() - session.startTime) / 1000);
    const finalSession = { ...session, outcome, duration, endTime: Date.now() };
    // Store completed session for 24h (for logging/notifications)
    await getRedis().setex(`call:${callSid}:completed`, COMPLETED_TTL, JSON.stringify(finalSession));
    await getRedis().del(`call:${callSid}`);
    logger.info('Session ended', { callSid, outcome, duration });
    return finalSession;
  } catch (err) {
    logger.error('endSession error', { error: err.message, callSid });
    return null;
  }
}

async function getCompletedSession(callSid) {
  try {
    const data = await getRedis().get(`call:${callSid}:completed`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('getCompletedSession error', { error: err.message });
    return null;
  }
}

module.exports = {
  connectRedis,
  createSession,
  getSession,
  updateSession,
  addMessage,
  endSession,
  getCompletedSession,
};
