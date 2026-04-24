// src/services/ttsService.js — SNEHAMVERSE Voice Agent
// FIX CRITICAL: output_format=ulaw_8000 in request BODY
// FIX CRITICAL: Accept header changed to audio/basic (mulaw)
// FIX: eleven_turbo_v2_5 — supports ulaw_8000, faster, cheaper
// FIX: timeout increased 3s → 5s (was too aggressive, caused false fallbacks)
// FIX: cache key includes format to prevent stale collisions

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 50;
const LANG_CODE  = { english: 'en', hindi: 'hi', telugu: 'te' };

// 160 bytes = 20ms of mulaw at 8000Hz — Twilio's expected frame size
const CHUNK_SIZE = 160;

async function textToSpeechElevenLabs(text, language) {
  const voiceId  = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const langCode = LANG_CODE[language];

  const body = {
    text,
    // FIX: eleven_turbo_v2_5 fully supports ulaw_8000 output
    // eleven_multilingual_v2 has limited output format support
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability:         0.50,
      similarity_boost:  0.85,
      style:             0.25,
      use_speaker_boost: true,
    },
    // FIX CRITICAL: output_format in BODY — URL query param is silently ignored
    // ulaw_8000 = mulaw 8kHz mono — exactly what Twilio Media Streams expects
    output_format: 'ulaw_8000',
  };

  if (langCode && langCode !== 'en') body.language_code = langCode;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000); // FIX: 3s was too short

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method:  'POST',
        headers: {
          'xi-api-key':   process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          // FIX CRITICAL: audio/basic = mulaw MIME type
          // audio/mpeg = MP3 which Twilio cannot decode on media streams
          'Accept': 'audio/basic',
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

// Split mulaw buffer into 160-byte (20ms) frames
// Twilio silently truncates large single-payload messages
// Without chunking: only first ~0.5s plays, rest is dropped
function chunkAudio(buffer) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function makeTwilioFallback(text, language) {
  return {
    isFallback: true,
    text,
    voice:    'Polly.Aditi',
    langCode: language === 'hindi' ? 'hi-IN' : 'en-IN',
  };
}

async function textToSpeech(text, language = 'english') {
  if (!text || !text.trim()) return null;

  // FIX: cache key includes format — prevents stale format collisions
  const cacheKey = `ulaw_8000:${language}:${text.substring(0, 120)}`;
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
      logger.debug('TTS via ElevenLabs', { language, chars: text.length, bytes: buf.length });
      return buf;
    } catch (err) {
      logger.warn('ElevenLabs failed — Twilio fallback', { error: err.message });
    }
  }

  return makeTwilioFallback(text, language);
}

module.exports = { textToSpeech, chunkAudio, CHUNK_SIZE };