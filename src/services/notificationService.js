// src/services/notificationService.js
// WhatsApp via Twilio + Google Sheets logging
// FIX: boolean flag check corrected (!== instead of !)
// FIX: Google Sheets tab name is now configurable via GOOGLE_SHEET_TAB_NAME env var

const twilio     = require('twilio');
const { google } = require('googleapis');
const { getLanguageConfig } = require('../config/languages');
const logger = require('../utils/logger');

// Lazy-init Twilio client to avoid crash if env vars are missing at import time
let _twilioClient;
function getTwilioClient() {
  if (!_twilioClient) {
    _twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return _twilioClient;
}

// ── Google Sheets Client ───────────────────────────────────────
function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Google Sheets credentials not configured');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // FIX: handle both Railway (\\n) and Windows (.env copy-paste) formats
      private_key:  process.env.GOOGLE_PRIVATE_KEY
        .replace(/\\n/g, '\n')
        .replace(/^"|"$/g, ''),  // strip surrounding quotes if any
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── WhatsApp: Booking Confirmation to Caller ──────────────────
// FIX: was `!process.env.ENABLE_WHATSAPP_CONFIRMATION === 'true'` (always false)
// FIXED to: `process.env.ENABLE_WHATSAPP_CONFIRMATION !== 'true'`
async function sendBookingConfirmation(callerPhone, bookingData, language = 'english') {
  if (process.env.ENABLE_WHATSAPP_CONFIRMATION !== 'true') return;
  if (!callerPhone || callerPhone === 'unknown' || !bookingData?.name) return;

  const langConfig = getLanguageConfig(language);
  const message = langConfig.bookingConfirm(
    bookingData.name,
    bookingData.requestedTime || 'the requested time'
  );

  try {
    await getTwilioClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to:   `whatsapp:${callerPhone}`,
      body: `*${process.env.BUSINESS_NAME}*\n\n${message}\n\n_Powered by SNEHAMVERSE AI_`,
    });
    logger.info('WhatsApp booking confirmation sent', { language });
  } catch (err) {
    logger.error('WhatsApp confirmation failed', { error: err.message });
    // Non-critical — don't rethrow
  }
}

// ── WhatsApp: Missed Call Auto-Reply ──────────────────────────
async function sendMissedCallMessage(callerPhone, language = 'english') {
  if (process.env.ENABLE_MISSED_CALL_HANDLER !== 'true') return;
  if (!callerPhone || callerPhone === 'unknown') return;

  const langConfig = getLanguageConfig(language);
  const message = langConfig.missedCallMsg(process.env.BUSINESS_NAME);

  try {
    await getTwilioClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to:   `whatsapp:${callerPhone}`,
      body: `*${process.env.BUSINESS_NAME}*\n\n${message}\n\n_Powered by SNEHAMVERSE AI_`,
    });
    logger.info('Missed call WhatsApp sent');
  } catch (err) {
    logger.error('Missed call WhatsApp failed', { error: err.message });
  }
}

// ── WhatsApp: Call Summary to Business Owner ──────────────────
async function sendOwnerSummary(session, summary) {
  if (process.env.ENABLE_OWNER_SUMMARY !== 'true') return;
  if (!process.env.OWNER_WHATSAPP) return;

  const langConfig = getLanguageConfig(session.language || 'english');
  const message = langConfig.ownerSummaryTemplate({
    businessName: process.env.BUSINESS_NAME,
    callerName:   session.bookingData?.name || 'Unknown',
    // Mask phone — only show last 4 digits
    callerPhone:  session.callerPhone ? '***' + String(session.callerPhone).slice(-4) : 'Unknown',
    appointment:  session.bookingData?.requestedTime || 'Not booked',
    language:     session.language || 'english',
    duration:     session.duration || 0,
    summary:      summary || 'No summary',
    outcome:      session.outcome || 'completed',
  });

  try {
    await getTwilioClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to:   `whatsapp:${process.env.OWNER_WHATSAPP}`,
      body: message,
    });
    logger.info('Owner summary sent');
  } catch (err) {
    logger.error('Owner summary failed', { error: err.message });
  }
}

// ── Google Sheets: Log Every Call ─────────────────────────────
// FIX: sheet tab name is now configurable via GOOGLE_SHEET_TAB_NAME (default: Calls)
async function logCallToSheets(session, summary) {
  if (process.env.ENABLE_SHEETS_LOGGING !== 'true') return;
  if (!process.env.GOOGLE_SHEETS_ID) return;

  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'Calls';

  try {
    const sheets = getSheetsClient();
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    await sheets.spreadsheets.values.append({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `${tabName}!A:J`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          now,
          session.callerPhone ? '***' + String(session.callerPhone).slice(-4) : 'Unknown',
          session.bookingData?.name        || 'Unknown',
          session.bookingData?.requestedTime || '-',
          session.language                 || 'english',
          session.duration                 || 0,
          session.outcome                  || 'completed',
          summary                          || '-',
          process.env.BUSINESS_NAME,
          session.callSid,
        ]]
      }
    });
    logger.info('Call logged to Google Sheets');
  } catch (err) {
    logger.error('Sheets logging failed', { error: err.message });
    // Non-critical — don't rethrow
  }
}

// ── Initialize Sheet Headers (run once on startup) ────────────
async function initSheetsHeaders() {
  if (!process.env.GOOGLE_SHEETS_ID) return;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return;

  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'Calls';

  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `${tabName}!A1:J1`,
      valueInputOption: 'RAW',
      resource: {
        values: [[
          'Timestamp', 'Phone (masked)', 'Caller Name',
          'Requested Time', 'Language', 'Duration (sec)',
          'Outcome', 'Summary', 'Business', 'Call SID'
        ]]
      }
    });
    logger.info('Google Sheets headers initialized', { tabName });
  } catch (err) {
    // Not fatal — headers may already exist
    logger.warn('Could not init sheet headers', { error: err.message });
  }
}

module.exports = {
  sendBookingConfirmation,
  sendMissedCallMessage,
  sendOwnerSummary,
  logCallToSheets,
  initSheetsHeaders,
};
