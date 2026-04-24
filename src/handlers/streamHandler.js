// src/handlers/streamHandler.js — SNEHAMVERSE
// FIX CRITICAL: chunkAudio() now called — sends 160-byte (20ms) mulaw frames
//               Previously sent entire buffer as one payload — Twilio truncated it
//               causing only first ~0.5s to play then silence
// FIX CRITICAL: setupDeepgram() moved from 'connected' to 'start' event
//               callSid/streamSid are null on 'connected' — transcripts fired before
//               'start' would call speakToUser(streamSid=null) and silently drop audio
// FIX HIGH: Twilio fallback TwiML re-includes <Start><Stream> to keep WebSocket alive
// FIX MEDIUM: bye detection now speaks a natural goodbye, not timeoutMessage
// All noise filters, VAD, debounce, confidence threshold retained from previous version

const WebSocket = require('ws');
const twilio    = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getAIResponse, generateCallSummary }    = require('../services/llmService');
const { textToSpeech, chunkAudio }              = require('../services/ttsService');
const { detectLanguage, getLanguageConfig }     = require('../config/languages');
const sessionManager = require('../services/sessionManager');
const {
  sendBookingConfirmation,
  sendOwnerSummary,
  logCallToSheets,
} = require('../services/notificationService');
const logger = require('../utils/logger');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 150;
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 30) * 1000;
const DEBOUNCE_MS      = 1200;
const MIN_TRANSCRIPT   = 8;
const MIN_CONFIDENCE   = 0.75;

// Bye patterns — triggers polite goodbye + hangup
const BYE_PATTERNS = [
  'bye', 'goodbye', 'good bye', 'see you', 'thank you bye',
  'thanks bye', "that's all", 'no thank you', 'not interested',
  'stop calling', 'do not call',
  'సరే', 'వెళ్తా', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు',
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'अलविदा', 'बाय', 'रहने दो',
];

// FIX: dedicated goodbye messages per language — not the timeout message
const GOODBYE = {
  english: `Thank you for calling ${process.env.BUSINESS_NAME || 'SnehAmverseAI'}! Have a wonderful day, take care!`,
  hindi:   `${process.env.BUSINESS_NAME || 'SnehAmverseAI'} को कॉल करने के लिए शुक्रिया! आपका दिन शुभ हो!`,
  telugu:  `${process.env.BUSINESS_NAME || 'SnehAmverseAI'} కి కాల్ చేసినందుకు ధన్యవాదాలు! మీ రోజు శుభంగా గడవాలి!`,
};

function detectBye(transcript) {
  const lower = transcript.toLowerCase().trim();
  return BYE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function sanitize(text) {
  return text
    .replace(/[^\w\s\u0900-\u097F\u0C00-\u0C7F.,!?'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const activeConnections = new Map();
const twilioRest = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function setupStreamHandler(wss) {
  wss.on('connection', (ws) => {
    logger.info('New WebSocket connection from Twilio');

    let callSid          = null;
    let callerPhone      = null;
    let dgConnection     = null;
    let isProcessing     = false;
    let transcriptBuffer = '';
    let streamSid        = null;
    let sessionEnded     = false;
    let silenceTimer     = null;
    let idleTimer        = null;
    let maxCallTimer     = null;
    let isSpeaking       = false;

    // ── Deepgram ──────────────────────────────────────────────
    function setupDeepgram() {
      try {
        dgConnection = deepgramClient.listen.live({
          model:            'nova-2',
          language:         'multi',
          smart_format:     true,
          interim_results:  true,
          utterance_end_ms: 1500,
          vad_events:       true,
          endpointing:      300,
          encoding:         'mulaw',
          sample_rate:      8000,
          channels:         1,
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          logger.debug('Deepgram open', { callSid });
        });

        dgConnection.on(LiveTranscriptionEvents.SpeechStarted, () => {
          isSpeaking = true;
        });

        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          isSpeaking = false;
          const final = sanitize(transcriptBuffer.trim());
          if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
            clearTimeout(silenceTimer);
            transcriptBuffer = '';
            await processUserInput(final);
          } else {
            transcriptBuffer = '';
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
          const alt          = data.channel?.alternatives?.[0];
          const transcript   = alt?.transcript;
          const isFinal      = data.is_final;
          const confidence   = alt?.confidence || 0;
          const detectedLang = data.channel?.detected_language;

          if (!transcript || !transcript.trim()) return;
          if (confidence < MIN_CONFIDENCE) return;

          resetIdleTimer();

          if (isFinal) {
            const clean = sanitize(transcript);
            if (!clean) return;

            transcriptBuffer += ' ' + clean;

            if (detectedLang && callSid) {
              const detectedKey = detectLanguage(detectedLang, clean);
              const session     = await sessionManager.getSession(callSid);
              if (session && session.language !== detectedKey) {
                await sessionManager.updateSession(callSid, { language: detectedKey });
                logger.info('Language switched', { callSid, to: detectedKey });
              }
            }

            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              const final = sanitize(transcriptBuffer.trim());
              transcriptBuffer = '';
              if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
                await processUserInput(final);
              }
            }, DEBOUNCE_MS);
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
          logger.error('Deepgram error — reconnecting', { error: err.message, callSid });
          setTimeout(() => { if (!sessionEnded) setupDeepgram(); }, 2000);
        });

        dgConnection.on(LiveTranscriptionEvents.Close, () => {
          logger.debug('Deepgram closed', { callSid });
        });

      } catch (err) {
        logger.error('Deepgram setup failed', { error: err.message });
      }
    }

    // ── Idle Timer ────────────────────────────────────────────
    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        if (sessionEnded) return;
        const session = await sessionManager.getSession(callSid);
        if (!session) return;
        const lang = getLanguageConfig(session.language);
        if ((session.idleWarningsSent || 0) === 0) {
          await sessionManager.updateSession(callSid, { idleWarningsSent: 1 });
          await speakToUser(lang.idleMessage, session.language);
          resetIdleTimer();
        } else {
          await speakToUser(lang.timeoutMessage, session.language);
          setTimeout(() => handleCallEnd('idle_timeout'), 3000);
        }
      }, IDLE_TIMEOUT_MS);
    }

    // ── Process speech → LLM → TTS → caller ──────────────────
    async function processUserInput(transcript) {
      if (isProcessing || sessionEnded) return;
      isProcessing = true;

      try {
        logger.info('Processing input', { callSid, chars: transcript.length });

        const session = await sessionManager.getSession(callSid);
        if (!session) {
          logger.warn('Session not found', { callSid });
          isProcessing = false;
          return;
        }

        // FIX: speak proper goodbye — not timeoutMessage
        if (detectBye(transcript)) {
          logger.info('Bye detected', { callSid });
          const goodbye = GOODBYE[session.language] || GOODBYE.english;
          await speakToUser(goodbye, session.language);
          setTimeout(() => handleCallEnd('caller_ended'), 3000);
          return;
        }

        await sessionManager.addMessage(callSid, 'user', transcript);
        const aiResult = await getAIResponse(session, transcript);
        await sessionManager.addMessage(callSid, 'assistant', aiResult.text);

        if (aiResult.bookingData) {
          await sessionManager.updateSession(callSid, {
            bookingData: { ...(session.bookingData || {}), ...aiResult.bookingData }
          });
          logger.info('Booking data captured', { callSid });
        }

        const freshSession    = await sessionManager.getSession(callSid);
        const currentLanguage = freshSession?.language || session.language;

        if (aiResult.transfer && process.env.ENABLE_HUMAN_TRANSFER === 'true') {
          await speakToUser(aiResult.text, currentLanguage);
          await handleTransfer();
          return;
        }

        await speakToUser(aiResult.text, currentLanguage);

        if (detectBye(aiResult.text)) {
          setTimeout(() => handleCallEnd('agent_ended'), 4000);
        }

      } catch (err) {
        logger.error('processUserInput error', { error: err.message, callSid });
      } finally {
        isProcessing = false;
      }
    }

    // ── TTS → send chunked audio to caller ───────────────────
    // FIX CRITICAL: chunkAudio() called — splits into 160-byte (20ms) mulaw frames
    // FIX HIGH: Twilio fallback re-includes <Start><Stream> to keep WebSocket alive
    async function speakToUser(text, language = 'english') {
      if (!text || !streamSid || sessionEnded) return;

      try {
        const result = await textToSpeech(text, language);
        if (!result) return;

        // ElevenLabs failed — use Twilio REST <Say>
        if (result.isFallback) {
          logger.info('Twilio <Say> fallback', { callSid });
          try {
            const wsHost = (process.env.BASE_URL || '').replace(/^https?:\/\//, '');
            await twilioRest.calls(callSid).update({
              // FIX: re-include <Start><Stream> so WebSocket stays alive after <Say>
              twiml: [
                '<Response>',
                `  <Say voice="${result.voice}" language="${result.langCode}">${escapeXml(result.text)}</Say>`,
                `  <Start><Stream url="wss://${wsHost}/call/stream"/></Start>`,
                '  <Pause length="3600"/>',
                '</Response>',
              ].join(''),
            });
          } catch (err) {
            logger.error('Twilio <Say> fallback failed', { error: err.message });
          }
          return;
        }

        if (ws.readyState !== WebSocket.OPEN) return;

        // FIX CRITICAL: chunk into 160-byte frames and send each separately
        // Twilio silently truncates large single-payload media messages
        const chunks = chunkAudio(result);
        for (const chunk of chunks) {
          if (ws.readyState !== WebSocket.OPEN) break;
          if (sessionEnded) break;
          ws.send(JSON.stringify({
            event:    'media',
            streamSid,
            media: { payload: chunk.toString('base64') },
          }));
        }

        logger.debug('Audio sent chunked', {
          chars:  text.length,
          bytes:  result.length,
          chunks: chunks.length,
          language,
        });

      } catch (err) {
        logger.error('speakToUser error', { error: err.message });
      }
    }

    async function handleTransfer() {
      if (!process.env.HUMAN_TRANSFER_NUMBER) return;
      try {
        await twilioRest.calls(callSid).update({
          twiml: `<Response><Dial>${process.env.HUMAN_TRANSFER_NUMBER}</Dial></Response>`
        });
        await sessionManager.updateSession(callSid, { outcome: 'transferred' });
        logger.info('Call transferred', { callSid });
      } catch (err) {
        logger.error('Transfer failed', { error: err.message });
      }
    }

    async function handleCallEnd(reason = 'completed') {
      if (sessionEnded) return;
      sessionEnded = true;
      clearTimeout(silenceTimer);
      clearTimeout(idleTimer);
      clearTimeout(maxCallTimer);

      logger.info('Call ended', { callSid, reason });

      try {
        await twilioRest.calls(callSid).update({
          twiml: `<Response><Hangup/></Response>`
        });
      } catch (err) {
        logger.warn('Hangup failed', { error: err.message });
      }

      try {
        const finalSession = await sessionManager.endSession(callSid, reason);
        if (!finalSession) return;

        const summary    = await generateCallSummary(finalSession);
        const hasBooking = finalSession.bookingData?.name || finalSession.bookingData?.institution;

        await Promise.allSettled([
          hasBooking
            ? sendBookingConfirmation(callerPhone, finalSession.bookingData, finalSession.language)
            : Promise.resolve(),
          sendOwnerSummary(finalSession, summary),
          logCallToSheets(finalSession, summary),
        ]);

        logger.info('Post-call done', { callSid, reason });

      } catch (err) {
        logger.error('handleCallEnd error', { error: err.message, callSid });
      } finally {
        activeConnections.delete(callSid);
        if (dgConnection) try { dgConnection.finish(); } catch {}
      }
    }

    // ── Twilio WebSocket message router ───────────────────────
    ws.on('message', async (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg);

        switch (msg.event) {

          case 'connected':
            // FIX CRITICAL: do NOT call setupDeepgram() here
            // callSid and streamSid are null on 'connected'
            // Move to 'start' where both are guaranteed to be set
            logger.debug('Twilio stream connected — waiting for start');
            break;

          case 'start':
            callSid     = msg.start?.callSid;
            streamSid   = msg.start?.streamSid;
            callerPhone = msg.start?.customParameters?.callerPhone || 'unknown';
            logger.info('Call stream started', { callSid });

            activeConnections.set(callSid, ws);

            try {
              await sessionManager.createSession(callSid, callerPhone);
            } catch (err) {
              logger.error('Session create failed', { error: err.message, callSid });
            }

            // FIX CRITICAL: setupDeepgram() here — callSid and streamSid now set
            setupDeepgram();

            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              logger.warn('Max call duration reached', { callSid });
              const session = await sessionManager.getSession(callSid);
              if (session) {
                await speakToUser(
                  getLanguageConfig(session.language).timeoutMessage,
                  session.language
                );
              }
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            // Greet after 1200ms — stream stabilize
            setTimeout(async () => {
              try {
                const session    = await sessionManager.getSession(callSid);
                const langConfig = getLanguageConfig(session?.language || 'english');
                const greeting   = langConfig.greeting();
                await speakToUser(greeting, session?.language || 'english');
                await sessionManager.addMessage(callSid, 'assistant', greeting);
                setTimeout(() => resetIdleTimer(), 500);
              } catch (err) {
                logger.error('Greeting error', { error: err.message, callSid });
              }
            }, 1200);
            break;

          case 'media':
            if (dgConnection && msg.media?.payload) {
              try {
                dgConnection.send(Buffer.from(msg.media.payload, 'base64'));
              } catch (err) {
                logger.error('Deepgram send error', { error: err.message });
              }
            }
            break;

          case 'stop':
            logger.info('Twilio stop event', { callSid });
            await handleCallEnd('completed');
            break;
        }

      } catch (err) {
        logger.error('WebSocket message error', { error: err.message });
      }
    });

    ws.on('close', async () => {
      logger.info('WebSocket closed', { callSid });
      clearTimeout(silenceTimer);
      await handleCallEnd('ws_closed');
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message, callSid });
    });
  });
}

module.exports = { setupStreamHandler };