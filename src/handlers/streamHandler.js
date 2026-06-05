// src/handlers/streamHandler.js — SNEHAMVERSE v2.3
//
// BARGE-IN FIX (v2.3):
//   - Added speakingAbortController to actually STOP audio frames when caller speaks
//   - Barge-in now sends Twilio 'clear' event to flush its jitter buffer immediately
//   - Caller speech is no longer discarded during barge-in — it flows to Deepgram normally
//   - isSpeaking is cleared immediately on barge-in so transcripts are not blocked
//
// ARCHITECTURE SUMMARY:
//   - TwiML uses track='both_tracks' (bidirectional stream)
//   - Inbound audio (caller → server): forwarded to Deepgram for transcription
//   - Outbound audio (server → caller): sent as WebSocket 'media' events (paced at 20ms/frame)
//   - WebSocket opened ONCE, stays open for the entire call
//   - No REST TwiML updates for audio
//   - REST API used ONLY for: hangup, human transfer, idle timeout hangup

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
const twilioRest     = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 150;
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 30) * 1000;
const DEBOUNCE_MS      = 1200;
const MIN_TRANSCRIPT   = 2;
const MIN_CONFIDENCE   = 0.55;
const FRAME_MS         = 20;   // mulaw frame duration — 160 bytes at 8kHz = 20ms

// Bye patterns — triggers polite goodbye + hangup
const BYE_PATTERNS = [
  'bye', 'goodbye', 'good bye', 'see you', 'thank you bye',
  'thanks bye', "that's all", 'no thank you', 'not interested',
  'stop calling', 'do not call',
  'సరే', 'వెళ్తా', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు',
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'अलविदा', 'बाय', 'रहने दो',
];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const activeConnections = new Map();

function setupStreamHandler(wss) {
  wss.on('connection', (ws) => {
    logger.info('New WebSocket connection from Twilio');

    let callSid               = null;
    let callerPhone           = null;
    let dgConnection          = null;
    let isProcessing          = false;
    let isSpeaking            = false;
    let speakingAbortController = null; // ← NEW: cancels in-progress audio loop
    let transcriptBuffer      = '';
    let streamSid             = null;
    let sessionEnded          = false;
    let silenceTimer          = null;
    let idleTimer             = null;
    let maxCallTimer          = null;

    // ── Helper: interrupt any currently-playing agent audio ───
    // Aborts the frame loop AND sends Twilio 'clear' to flush its buffer.
    // Called on barge-in so the caller's words are never discarded.
    function interruptSpeaking() {
      if (!isSpeaking) return;
      logger.debug('Barge-in — interrupting agent audio', { callSid });
      if (speakingAbortController) {
        speakingAbortController.abort();
        speakingAbortController = null;
      }
      isSpeaking = false;
      // Flush Twilio's jitter buffer so caller hears silence immediately
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    }

    // ── Deepgram ──────────────────────────────────────────────
    function setupDeepgram() {
      try {
        dgConnection = deepgramClient.listen.live({
          model:           'nova-2',
          language:        'multi',
          smart_format:    true,
          interim_results: true,
          vad_events:      true,
          endpointing:     500,
          encoding:        'mulaw',
          sample_rate:     8000,
          channels:        1,
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          logger.debug('Deepgram open', { callSid });
        });

        dgConnection.on(LiveTranscriptionEvents.SpeechStarted, () => {
          // Caller started speaking — interrupt agent audio immediately
          if (isSpeaking) interruptSpeaking();
          clearTimeout(silenceTimer);
        });

        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          if (isSpeaking) {
            logger.debug('UtteranceEnd during speaking — ignored', { callSid });
            return;
          }
          clearTimeout(silenceTimer);
          const final = sanitize(transcriptBuffer.trim());
          transcriptBuffer = '';
          if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
            logger.info('UtteranceEnd triggered processing', { callSid, text: final });
            await processUserInput(final);
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
          const alt          = data.channel?.alternatives?.[0];
          const transcript   = alt?.transcript;
          const isFinal      = data.is_final;
          const confidence   = alt?.confidence || 0;
          const detectedLang = data.channel?.detected_language;

          if (transcript && transcript.trim()) {
            logger.debug('Deepgram transcript', {
              callSid,
              text:       transcript.substring(0, 80),
              confidence: confidence.toFixed(2),
              isFinal,
              blocked:    confidence < MIN_CONFIDENCE ? 'lowConf' : 'none',
            });
          }

          if (!transcript || !transcript.trim()) return;
          if (confidence < MIN_CONFIDENCE) return;

          // ── BARGE-IN ──────────────────────────────────────
          // Interrupt agent audio if still playing, then fall through
          // so this transcript is processed normally (not discarded).
          if (isSpeaking) interruptSpeaking();

          resetIdleTimer();

          const clean = sanitize(transcript);
          if (!clean) return;

          transcriptBuffer = clean;

          // Language detection
          if (detectedLang && callSid) {
            const detectedKey = detectLanguage(detectedLang, clean);
            const session     = await sessionManager.getSession(callSid);
            if (session && session.language !== detectedKey) {
              await sessionManager.updateSession(callSid, { language: detectedKey });
              logger.info('Language switched', { callSid, to: detectedKey });
            }
          }

          // Fallback debounce in case UtteranceEnd doesn't fire
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(async () => {
            if (isSpeaking) return;
            const final = sanitize(transcriptBuffer.trim());
            transcriptBuffer = '';
            if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
              logger.info('Debounce fallback triggered processing', { callSid, text: final });
              await processUserInput(final);
            }
          }, DEBOUNCE_MS);
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
          return;
        }

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

    // ── TTS → paced mulaw frames → WebSocket → caller ─────────
    //
    // HOW THIS WORKS:
    //   1. ElevenLabs returns a mulaw 8kHz mono Buffer
    //   2. chunkAudio() splits it into 160-byte (20ms) frames
    //   3. Each frame is base64-encoded and sent as a WebSocket 'media' event
    //   4. We wait 20ms between frames to match real-time playback speed
    //   5. Twilio receives frames at the correct rate and plays them to caller
    //
    // BARGE-IN CANCELLATION (v2.3):
    //   - speakingAbortController is created fresh for every speakToUser() call
    //   - interruptSpeaking() aborts the controller and sends Twilio 'clear'
    //   - The frame loop checks signal.aborted on every iteration and exits cleanly
    //   - isSpeaking is reset immediately by interruptSpeaking(), not after the loop
    //
    async function speakToUser(text, language = 'english') {
      if (!text || !streamSid || sessionEnded) return;

      // Cancel any previous audio that is still streaming
      if (speakingAbortController) {
        speakingAbortController.abort();
      }
      const controller = new AbortController();
      speakingAbortController = controller;
      const { signal } = controller;

      try {
        const result = await textToSpeech(text, language);
        if (!result || signal.aborted) return;

        // ── Twilio <Say> fallback (ElevenLabs failed) ─────────
        if (result.isFallback) {
          logger.info('Twilio <Say> fallback', { callSid });
          try {
            await twilioRest.calls(callSid).update({
              twiml: [
                '<Response>',
                `  <Say voice="${result.voice}" language="${result.langCode}">${escapeXml(result.text)}</Say>`,
                `  <Pause length="3600"/>`,
                '</Response>',
              ].join(''),
            });
          } catch (err) {
            logger.error('Twilio <Say> fallback failed', { error: err.message });
          }
          return;
        }

        if (ws.readyState !== WebSocket.OPEN) return;

        // ── Pace mulaw frames at 20ms intervals ───────────────
        isSpeaking = true;
        const chunks = chunkAudio(result);

        logger.debug('Streaming audio to caller', {
          callSid,
          chars:    text.length,
          bytes:    result.length,
          frames:   chunks.length,
          estMs:    chunks.length * FRAME_MS,
          language,
        });

        for (const chunk of chunks) {
          // Exit immediately if barge-in occurred or session ended
          if (signal.aborted || ws.readyState !== WebSocket.OPEN || sessionEnded) {
            // Flush Twilio buffer (interruptSpeaking already sent 'clear',
            // but send again defensively if loop exits for other reasons)
            if (!signal.aborted && ws.readyState === WebSocket.OPEN && streamSid) {
              ws.send(JSON.stringify({ event: 'clear', streamSid }));
            }
            break;
          }
          ws.send(JSON.stringify({
            event:    'media',
            streamSid,
            media: { payload: chunk.toString('base64') },
          }));
          await sleep(FRAME_MS);
        }

        // Only send mark + reset state if we weren't interrupted
        if (!signal.aborted) {
          if (ws.readyState === WebSocket.OPEN && !sessionEnded) {
            ws.send(JSON.stringify({
              event:    'mark',
              streamSid,
              mark:     { name: 'playback_complete' },
            }));
          }
          isSpeaking = false;
          speakingAbortController = null;
          logger.debug('Audio streaming complete', { callSid, frames: chunks.length });
        }
        // If aborted: isSpeaking was already reset by interruptSpeaking()

      } catch (err) {
        if (err.name !== 'AbortError') {
          logger.error('speakToUser error', { error: err.message });
        }
        isSpeaking = false;
        speakingAbortController = null;
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

      // Cancel any in-progress audio
      if (speakingAbortController) {
        speakingAbortController.abort();
        speakingAbortController = null;
      }
      isSpeaking = false;

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
              logger.info('Session created', { callSid });
            } catch (err) {
              logger.error('Session create failed', { error: err.message, callSid });
            }

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

            // Greet after 1200ms — let stream stabilise
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
            // Only forward inbound (caller) audio to Deepgram
            if (msg.media?.track === 'outbound') return;
            if (dgConnection && msg.media?.payload) {
              try {
                dgConnection.send(Buffer.from(msg.media.payload, 'base64'));
              } catch (err) {
                logger.error('Deepgram send error', { error: err.message });
              }
            }
            break;

          case 'mark':
            // Twilio confirms our audio finished playing
            if (msg.mark?.name === 'playback_complete') {
              isSpeaking = false;
            }
            logger.debug('Playback mark received', { callSid, name: msg.mark?.name });
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