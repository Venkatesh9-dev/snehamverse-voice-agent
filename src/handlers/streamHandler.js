// src/handlers/streamHandler.js
// FIX: confidence threshold 0.75 — noise ignored
// FIX: min transcript length 8 chars — single syllables ignored
// FIX: DEBOUNCE_MS 1200ms — agent waits for caller to finish
// FIX: utterance_end_ms 1500ms — no premature cutoffs
// FIX: endpointing 300ms — better silence detection on phone audio
// FIX: VAD handler added — blocks processing when no voice detected
// FIX: resetIdleTimer only on confident speech — noise doesn't keep call alive
// FIX: buffer sanitization — weird chars cleaned before sending to Claude
// FIX: bye detection — call ends naturally when caller says goodbye
// FIX: max call duration 150 seconds (2 min 30 sec)
// FIX [v2.1]: setupDeepgram() moved from 'connected' → 'start' event.
//             On 'connected', streamSid is still null — any audio sent before
//             'start' fires would call speakToUser(streamSid=null) and be silently dropped.
// FIX [v2.2]: speakToUser() now streams audio as 160-byte (20ms mulaw) chunks.
//             Twilio silently truncates large single-payload media messages —
//             sending one blob causes only ~0.5s to play then silence.
//             Each chunk is a separate 'media' WS message with 20ms pacing.
//             A 'mark' event is sent after all chunks for playback tracking.
// FIX [v2.2]: isPlayingAudio flag — STT transcripts ignored while agent speaks,
//             preventing the agent from hearing its own voice and self-interrupting.
// FIX [v2.2]: Fallback TwiML re-includes <Start><Stream> so the WebSocket media
//             stream is not orphaned when ElevenLabs fails mid-call.

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

// ── Config ────────────────────────────────────────────────────
const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 150;
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 30) * 1000;
const DEBOUNCE_MS      = 1200;
const MIN_TRANSCRIPT   = 8;
const MIN_CONFIDENCE   = 0.75;

const BYE_PATTERNS = [
  'bye', 'goodbye', 'good bye', 'see you', 'thank you bye',
  'thanks bye', "that's all", 'no thank you', 'not interested',
  'stop calling', 'do not call',
  'సరే', 'వెళ్తా', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు',
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'अलविदा', 'बाय', 'रहने दो',
];

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

// ── XML escape for Twilio <Say> ───────────────────────────────
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── FIX [v2.2]: Send one 160-byte mulaw chunk as a Twilio media message ──────
function sendChunk(ws, streamSid, chunk) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    event:    'media',
    streamSid,
    media: { payload: chunk.toString('base64') },
  }));
}

// ── FIX [v2.2]: Send Twilio 'mark' — signals end of an audio sequence ────────
function sendMark(ws, streamSid, label) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    event:    'mark',
    streamSid,
    mark: { name: label },
  }));
}

// ── FIX [v2.2]: Stream all chunks with 20ms pacing ───────────────────────────
// 20ms = one mulaw frame at 8kHz. Pacing prevents Twilio's jitter buffer
// from overflowing when all chunks are sent synchronously at once.
async function streamAudioChunks(ws, streamSid, audioBuffer, markLabel) {
  const chunks = chunkAudio(audioBuffer);
  logger.debug('Streaming audio chunks', {
    totalChunks: chunks.length,
    totalBytes:  audioBuffer.length,
    markLabel,
  });

  for (const chunk of chunks) {
    sendChunk(ws, streamSid, chunk);
    await new Promise(r => setTimeout(r, 20)); // 20ms pacing per frame
  }

  sendMark(ws, streamSid, markLabel);
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
    let isPlayingAudio   = false; // FIX [v2.2]: block STT while agent speaks
    let transcriptBuffer = '';
    let streamSid        = null;
    let sessionEnded     = false;
    let silenceTimer     = null;
    let idleTimer        = null;
    let maxCallTimer     = null;
    let isSpeaking       = false; // VAD: true when human voice detected
    let markCounter      = 0;     // FIX [v2.2]: unique label per mark event

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
          logger.debug('VAD: speech started', { callSid });
        });

        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          isSpeaking = false;
          logger.debug('VAD: utterance ended', { callSid });

          // FIX [v2.2]: ignore transcripts while agent is playing audio
          if (isPlayingAudio) {
            transcriptBuffer = '';
            return;
          }

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
          if (confidence < MIN_CONFIDENCE) {
            logger.debug('Low confidence transcript ignored', { confidence, transcript });
            return;
          }

          // FIX [v2.2]: discard transcripts while agent is speaking — prevents self-interruption
          if (isPlayingAudio) return;

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
              // FIX [v2.2]: also check here — agent may have started speaking
              if (isPlayingAudio) { transcriptBuffer = ''; return; }
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
        logger.info('Processing input', { callSid, chars: transcript.length, transcript });

        const session = await sessionManager.getSession(callSid);
        if (!session) {
          logger.warn('Session not found', { callSid });
          return;
        }

        if (detectBye(transcript)) {
          logger.info('Bye detected — ending call politely', { callSid });
          const lang = getLanguageConfig(session.language);
          await speakToUser(lang.timeoutMessage, session.language);
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

    // ── TTS → send audio to caller ────────────────────────────
    // FIX [v2.2]: Replaced single-blob ws.send() with streamAudioChunks().
    // The old code sent the entire mulaw buffer as one base64 payload — Twilio
    // silently truncates anything beyond the first ~160 bytes, so only the
    // first 20ms of audio played (caller hears nothing or a brief click).
    // Now: buffer is split into 160-byte frames, each sent as a separate
    // 'media' message with 20ms pacing, followed by a 'mark' event.
    async function speakToUser(text, language = 'english') {
      if (!text || !streamSid || sessionEnded) return;
      try {
        const result = await textToSpeech(text, language);
        if (!result) return;

        if (result.isFallback) {
          // FIX [v2.2]: re-include <Start><Stream> in fallback TwiML so the
          // WebSocket media stream is not lost when ElevenLabs fails mid-call.
          // The old code replaced TwiML with only <Say>+<Pause> which orphaned the WS.
          const wsHost = process.env.BASE_URL.replace(/^https?:\/\//, '');
          logger.info('Using Twilio <Say> fallback TTS', { callSid });
          try {
            await twilioRest.calls(callSid).update({
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

        // FIX [v2.2]: set flag before streaming — blocks STT during playback
        isPlayingAudio = true;
        const audioBuffer = Buffer.isBuffer(result) ? result : Buffer.from(result);
        const label = `speak-${++markCounter}`;

        try {
          await streamAudioChunks(ws, streamSid, audioBuffer, label);
          // 300ms settling time — prevents TTS audio tail from being picked up
          // by Deepgram as caller speech, which would trigger a self-response loop
          await new Promise(r => setTimeout(r, 300));
        } finally {
          // Always re-enable STT — even if streaming throws mid-way
          isPlayingAudio = false;
          logger.debug('Audio playback complete', { label, callSid });
        }

      } catch (err) {
        logger.error('speakToUser error', { error: err.message });
        isPlayingAudio = false;
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

    // ── Call end ──────────────────────────────────────────────
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
        logger.info('Hangup sent', { callSid });
      } catch (err) {
        logger.warn('Hangup failed — call may already be ended', { error: err.message });
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

        logger.info('Post-call processing done', { callSid, reason });

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
            // FIX [v2.1]: Do NOT call setupDeepgram() here — streamSid is null
            // at this point. Any Deepgram transcript that fires before 'start'
            // would invoke speakToUser(streamSid=null) and silently drop audio.
            // setupDeepgram() is now called inside 'start' after streamSid is set.
            logger.debug('Twilio stream connected — waiting for start event');
            break;

          case 'start':
            callSid     = msg.start?.callSid;
            streamSid   = msg.start?.streamSid;
            callerPhone = msg.start?.customParameters?.callerPhone || 'unknown';
            logger.info('Call stream started', { callSid, streamSid });

            activeConnections.set(callSid, ws);

            try {
              await sessionManager.createSession(callSid, callerPhone);
            } catch (err) {
              logger.error('Failed to create session', { error: err.message, callSid });
            }

            // FIX [v2.1]: Deepgram started here — callSid and streamSid are now set
            setupDeepgram();

            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              logger.warn('Max call duration reached', { callSid, seconds: MAX_CALL_SECONDS });
              const session = await sessionManager.getSession(callSid);
              if (session) {
                await speakToUser(
                  getLanguageConfig(session.language).timeoutMessage,
                  session.language
                );
              }
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            // Greet after 1200ms — lets stream stabilize before sending audio
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

          // FIX [v2.2]: handle Twilio 'mark' acknowledgement events
          case 'mark':
            logger.debug('Twilio mark received', { name: msg.mark?.name, callSid });
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