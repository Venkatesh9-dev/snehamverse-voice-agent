// src/services/ttsService.js
// ElevenLabs eleven_multilingual_v2 — human-quality Telugu, Hindi, English
// Fallback: Twilio <Say> if ElevenLabs fails or is unavailable

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 50;
const LANG_CODE  = { english: 'en', hindi: 'hi', telugu: 'te' };

// ── Primary: ElevenLabs multilingual v2 ──────────────────────
async function textToSpeechElevenLabs(text, language) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  const body = {
    text,
    model_id: 'eleven_multilingual_v2',        // ✅ human-quality for Telugu & Hindi
    voice_settings: {
      stability:        0.45,                  // slightly lower = more natural variation
      similarity_boost: 0.90,
      style:            0.35,                  // adds expressiveness — sounds less robotic
      use_speaker_boost: true,
    },
  };

  const langCode = LANG_CODE[language];
  if (langCode && langCode !== 'en') body.language_code = langCode;

  // ── 3 second timeout — fail fast to fallback ──────────────
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method:  'POST',
        headers: {
          'xi-api-key':   process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs ${response.status}: ${err}`);
    }

    return Buffer.from(await response.arrayBuffer());

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Fallback: Twilio built-in <Say> via TwiML ─────────────────
// Note: Polly.Aditi is Hindi — no native Telugu Polly voice exists.
// For Telugu callers ElevenLabs multilingual_v2 is essential.
function makeTwilioFallback(text, language) {
  return {
    isFallback: true,
    text,
    voice:    'Polly.Aditi',
    langCode: language === 'hindi'  ? 'hi-IN'
            : language === 'telugu' ? 'te-IN'
            : 'en-IN',
  };
}

// ── Main export ───────────────────────────────────────────────
async function textToSpeech(text, language = 'english') {
  if (!text || !text.trim()) return null;

  const cacheKey = `${language}:${text.substring(0, 120)}`;
  if (audioCache.has(cacheKey)) {
    logger.debug('TTS cache hit', { language });
    return audioCache.get(cacheKey);
  }

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const buf = await textToSpeechElevenLabs(text, language);
      if (audioCache.size >= MAX_CACHE) {
        audioCache.delete(audioCache.keys().next().value);
      }
      audioCache.set(cacheKey, buf);
      logger.debug('TTS via ElevenLabs multilingual_v2', { language, chars: text.length });
      return buf;
    } catch (err) {
      logger.warn('ElevenLabs unavailable — switching to Twilio TTS fallback', {
        error: err.message,
      });
    }
  }

  return makeTwilioFallback(text, language);
}

module.exports = { textToSpeech };