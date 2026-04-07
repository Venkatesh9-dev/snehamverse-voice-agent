// src/services/ttsService.js
// ElevenLabs Turbo v2.5 — primary TTS
// FIX: Twilio fallback TTS when ElevenLabs fails/blocked (free tier VPN detection)
// FIX: returns special fallback object so streamHandler can use Twilio <Say>

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 50;
const LANG_CODE  = { english: 'en', hindi: 'hi', telugu: 'te' };

// ── Primary: ElevenLabs ───────────────────────────────────────
async function textToSpeechElevenLabs(text, language) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const body    = {
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.20, use_speaker_boost: true },
  };
  const langCode = LANG_CODE[language];
  if (langCode && langCode !== 'en') body.language_code = langCode;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method:  'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ── Fallback: signals streamHandler to use Twilio's built-in <Say> ───
function makeTwilioFallback(text, language) {
  return {
    isFallback: true,
    text,
    voice:    'Polly.Aditi',
    langCode: language === 'hindi' ? 'hi-IN' : language === 'telugu' ? 'te-IN' : 'en-IN',
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
      if (audioCache.size >= MAX_CACHE) audioCache.delete(audioCache.keys().next().value);
      audioCache.set(cacheKey, buf);
      logger.debug('TTS via ElevenLabs', { language, chars: text.length });
      return buf;
    } catch (err) {
      logger.warn('ElevenLabs unavailable — switching to Twilio TTS fallback', { error: err.message });
    }
  }

  // Return fallback marker — streamHandler handles it via TwiML REST call
  return makeTwilioFallback(text, language);
}

module.exports = { textToSpeech };
