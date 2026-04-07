// src/handlers/streamHandler.js
// Core pipeline: Twilio Audio → Deepgram STT → Claude → ElevenLabs/Twilio TTS → Caller
// FIX: sessionEnded guard prevents double WhatsApp / double Sheets logging
// FIX: Deepgram send wrapped in try/catch
// FIX: null session guard — waits for Redis before processing
// FIX: handles TTS fallback object (uses Twilio REST <Say> when ElevenLabs blocked)
// FIX: call timeout + idle timeout

const WebSocket = require('ws');
const twilio    = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getAIResponse, generateCallSummary }    = require('../services/llmService');
const { textToSpeech }                          = require('../services/ttsService');
const { detectLanguage, getLanguageConfig }     = require('../config/languages');
const sessionManager = require('../services/sessionManager');
const {
  sendBookingConfirmation,
  sendOwnerSummary,
  logCallToSheets,
} = require('../services/notificationService');
const logger = require('../utils/logger');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 600;
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 30) * 1000;
const DEBOUNCE_MS      = 800;

const activeConnections = new Map();

// Twilio REST client for fallback TTS + transfer
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
    let sessionEnded     = false;  // Guard against double call-end processing
    let silenceTimer     = null;
    let idleTimer        = null;
    let maxCallTimer     = null;

    // ── Deepgram ──────────────────────────────────────────────
    function setupDeepgram() {
      try {
        dgConnection = deepgramClient.listen.live({
          model:            'nova-2',
          language:         'multi',
          smart_format:     true,
          interim_results:  true,
          utterance_end_ms: 1000,
          vad_events:       true,
          encoding:         'mulaw',
          sample_rate:      8000,
          channels:         1,
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          logger.debug('Deepgram open', { callSid });
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
          const transcript   = data.channel?.alternatives?.[0]?.transcript;
          const isFinal      = data.is_final;
          const detectedLang = data.channel?.detected_language;

          if (!transcript || !transcript.trim()) return;
          resetIdleTimer();

          if (isFinal) {
            transcriptBuffer += ' ' + transcript;

            if (detectedLang && callSid) {
              const detectedKey = detectLanguage(detectedLang, transcript);
              const session     = await sessionManager.getSession(callSid);
              if (session && session.language !== detectedKey) {
                await sessionManager.updateSession(callSid, { language: detectedKey });
                logger.info('Language switched', { callSid, to: detectedKey });
              }
            }

            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              const final = transcriptBuffer.trim();
              transcriptBuffer = '';
              if (final.length >= 2 && !isProcessing) await processUserInput(final);
            }, DEBOUNCE_MS);
          }
        });

        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          if (transcriptBuffer.trim().length > 0 && !isProcessing) {
            clearTimeout(silenceTimer);
            const final = transcriptBuffer.trim();
            transcriptBuffer = '';
            await processUserInput(final);
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
        const session = await sessionManager.getSession(callSid);
        // FIX: guard against null session (Redis not ready yet)
        if (!session) {
          logger.warn('Session not found — Redis may still be connecting', { callSid });
          isProcessing = false;
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

        if (aiResult.transfer && process.env.ENABLE_HUMAN_TRANSFER === 'true') {
          await speakToUser(aiResult.text, session.language);
          await handleTransfer();
          return;
        }

        await speakToUser(aiResult.text, session.language);

      } catch (err) {
        logger.error('processUserInput error', { error: err.message, callSid });
      } finally {
        isProcessing = false;
      }
    }

    // ── TTS → send audio to caller ────────────────────────────
    // FIX: handles both Buffer (ElevenLabs) and fallback object (Twilio <Say>)
    async function speakToUser(text, language = 'english') {
      if (!text || !streamSid || sessionEnded) return;
      try {
        const result = await textToSpeech(text, language);
        if (!result) return;

        // FIX: if ElevenLabs was blocked, result is { isFallback, text, voice, langCode }
        // Use Twilio REST API to inject <Say> TwiML into the live call
        if (result.isFallback) {
          logger.info('Using Twilio <Say> fallback TTS', { callSid });
          try {
            await twilioRest.calls(callSid).update({
              twiml: `<Response><Say voice="${result.voice}" language="${result.langCode}">${escapeXml(result.text)}</Say><Pause length="60"/></Response>`
            });
          } catch (err) {
            logger.error('Twilio <Say> fallback failed', { error: err.message });
          }
          return;
        }

        // Normal path: ElevenLabs audio buffer → send as media stream
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          event:    'media',
          streamSid,
          media: { payload: result.toString('base64') },
        }));

        logger.debug('Audio sent via ElevenLabs', { chars: text.length, language });

      } catch (err) {
        logger.error('speakToUser error', { error: err.message });
      }
    }

    // ── Transfer to human ─────────────────────────────────────
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

    // ── Call end — sessionEnded guard prevents double-fire ────
    async function handleCallEnd(reason = 'completed') {
      if (sessionEnded) return;
      sessionEnded = true;
      clearTimeout(silenceTimer);
      clearTimeout(idleTimer);
      clearTimeout(maxCallTimer);

      logger.info('Call ended', { callSid, reason });

      try {
        const finalSession = await sessionManager.endSession(callSid, reason);
        if (!finalSession) return;

        const summary = await generateCallSummary(finalSession);

        await Promise.allSettled([
          finalSession.bookingData?.name
            ? sendBookingConfirmation(callerPhone, finalSession.bookingData, finalSession.language)
            : Promise.resolve(),
          sendOwnerSummary(finalSession, summary),
          logCallToSheets(finalSession, summary),
        ]);

        logger.info('Post-call processing done', { callSid });

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
            logger.debug('Twilio stream connected');
            setupDeepgram();
            break;

          case 'start':
            callSid     = msg.start?.callSid;
            streamSid   = msg.start?.streamSid;
            callerPhone = msg.start?.customParameters?.callerPhone || 'unknown';
            logger.info('Call stream started', { callSid });

            activeConnections.set(callSid, ws);

            // FIX: create session here synchronously, then greet
            try {
              await sessionManager.createSession(callSid, callerPhone);
            } catch (err) {
              logger.error('Failed to create session', { error: err.message, callSid });
            }

            // Max duration guard
            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              logger.warn('Max call duration reached', { callSid });
              const session = await sessionManager.getSession(callSid);
              if (session) await speakToUser(getLanguageConfig(session.language).timeoutMessage, session.language);
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            // Greet caller
            setTimeout(async () => {
              try {
                const session    = await sessionManager.getSession(callSid);
                const langConfig = getLanguageConfig(session?.language || 'english');
                const greeting   = langConfig.greeting();
                await speakToUser(greeting, session?.language || 'english');
                await sessionManager.addMessage(callSid, 'assistant', greeting);
                resetIdleTimer();
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

// ── XML escape for Twilio <Say> ───────────────────────────────
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { setupStreamHandler };
