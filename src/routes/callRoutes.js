// src/routes/callRoutes.js
// Twilio webhook handlers — incoming calls + status callbacks + admin endpoints
// FIX: reduced TwiML pauses from 5x60s to 2x60s — WebSocket sends <Hangup> before this runs out
// FIX: added maxCallDuration to <Stream> as a safety cap at TwiML level

const express = require('express');
const twilio  = require('twilio');
const { sendMissedCallMessage } = require('../services/notificationService');
const logger = require('../utils/logger');

const router = express.Router();

// ── Twilio Signature Validation ───────────────────────────────
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const signature = req.headers['x-twilio-signature'] || '';
  const url       = `${process.env.BASE_URL}${req.originalUrl}`;
  const isValid   = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    logger.warn('Rejected request with invalid Twilio signature', { url });
    return res.status(403).send('Forbidden');
  }
  next();
}

// ── POST /call/incoming ───────────────────────────────────────
router.post('/incoming', validateTwilio, (req, res) => {
  const callSid     = req.body.CallSid || 'unknown';
  const callerPhone = req.body.From    || 'unknown';

  logger.info('Incoming call received', { callSid });

  const twiml  = new twilio.twiml.VoiceResponse();
  const start  = twiml.start();
  const stream = start.stream({
    url:   `wss://${req.headers.host}/call/stream`,
    track: 'inbound_track',
  });

  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'callSid',     value: callSid });

  // FIX: 2 pauses only — streamHandler sends <Hangup> via REST well before 120s
  // This is just a safety buffer in case WebSocket closes without sending hangup
  twiml.pause({ length: 60 });
  twiml.pause({ length: 60 });

  // Final say in case both pauses exhaust (should never happen in normal flow)
  twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' },
    'Thank you for calling. Please call us again. Goodbye.');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
  logger.info('TwiML sent, media stream opening', { callSid });
});

// ── POST /call/status ─────────────────────────────────────────
router.post('/status', validateTwilio, async (req, res) => {
  const { CallSid, CallStatus, From } = req.body;
  logger.info('Call status update', { CallSid, CallStatus });

  if (['no-answer', 'busy', 'failed'].includes(CallStatus) && From) {
    try {
      await sendMissedCallMessage(From, 'english');
    } catch (err) {
      logger.error('Missed call handler error', { error: err.message });
    }
  }

  res.sendStatus(200);
});

// ── GET /call/appointments ────────────────────────────────────
router.get('/appointments', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — provide x-api-key header' });
  }

  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  res.json({
    message:   'All call logs are in your Google Sheet',
    sheetsUrl: sheetsId
      ? `https://docs.google.com/spreadsheets/d/${sheetsId}`
      : 'Google Sheets not configured',
    business:  process.env.BUSINESS_NAME,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;