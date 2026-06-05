// src/services/llmService.js — SNEHAMVERSE v2.3
//
// FIX v2.3: max_tokens reduced 100 → 60 — voice responses MUST be ≤ 2 sentences / ~15 words
//   A 56-token response produces 198 chars = ~6.5 seconds of TTS audio.
//   Caller cannot hear 24 seconds of audio before the agent lets them speak.
//   Target: 15–25 words per response = ~2.5 seconds of audio = natural conversation.
//
// FIX v2.3: Injected hard length constraint into every system prompt via a prefix.
//   Even if prompts.js doesn't enforce brevity, this wrapper guarantees it.
//
// FIX: extractBookingData supports both clinic (name) and snehamverse (institution) types
// KEPT: generateCallSummary unchanged

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../config/prompts');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Hard voice-length constraint prefix ───────────────────────
// Prepended to every system prompt regardless of what prompts.js says.
// Forces the model to stay within ~15 words = ~2 seconds of TTS audio.
const VOICE_BREVITY_PREFIX = `CRITICAL VOICE RULE: You are speaking on a phone call. Every response MUST be 15 words or fewer. Never use more than 2 sentences. Do NOT introduce yourself, do NOT list services, do NOT give long explanations. Answer only what was asked. Be direct and conversational.

`;

// ── Extract booking JSON from LLM response ────────────────────
function extractBookingData(responseText) {
  try {
    const match = responseText.match(/BOOKING_JSON:(\{[^}]+\})/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      const hasClinicBooking      = parsed.name && parsed.name !== 'CALLER_NAME';
      const hasSnehAmverseBooking = parsed.institution && parsed.institution !== 'INSTITUTION_NAME';
      if (hasClinicBooking || hasSnehAmverseBooking) return parsed;
    }
  } catch { /* ignore malformed JSON */ }
  return null;
}

// ── Strip BOOKING_JSON tag before TTS ─────────────────────────
function cleanResponseText(text) {
  return text.replace(/BOOKING_JSON:\{[^}]+\}/g, '').trim();
}

// ── Detect transfer signal ────────────────────────────────────
function needsTransfer(text) {
  return text.includes('TRANSFER_NOW');
}

// ── Strip transfer signal from spoken text ────────────────────
function cleanTransferText(text) {
  return text.replace('TRANSFER_NOW', '').trim();
}

// ── Main: get AI response ─────────────────────────────────────
async function getAIResponse(session, userTranscript, customFAQs = []) {
  const baseSystemPrompt = buildSystemPrompt(
    process.env.BUSINESS_TYPE || 'snehamverse',
    session.language,
    customFAQs
  );

  // Prepend the hard brevity constraint — this overrides whatever prompts.js says
  const systemPrompt = VOICE_BREVITY_PREFIX + baseSystemPrompt;

  // Only send last 10 messages to keep tokens low
  const recentMessages = session.messages.slice(-10);

  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 60,   // 60 tokens ≈ 15–20 words — hard ceiling for voice
      system:     systemPrompt,
      messages:   [
        ...recentMessages,
        { role: 'user', content: userTranscript },
      ],
    });

    const rawText     = response.content[0]?.text || '';
    const transfer    = needsTransfer(rawText);
    const bookingData = extractBookingData(rawText);
    let   cleanText   = cleanResponseText(rawText);
    if (transfer) cleanText = cleanTransferText(cleanText);

    logger.info('LLM response generated', {
      callSid:      session.callSid,
      language:     session.language,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      hasBooking:   !!bookingData,
      transfer,
      responsePreview: cleanText.substring(0, 60),
    });

    return { text: cleanText, bookingData, transfer };

  } catch (err) {
    logger.error('LLM error', { error: err.message, callSid: session.callSid });
    const fallbacks = {
      english: "Sorry, could you repeat that?",
      hindi:   'माफ़ करें, दोबारा बोलें।',
      telugu:  'క్షమించండి, మళ్ళీ చెప్పండి.',
    };
    return {
      text:        fallbacks[session.language] || fallbacks.english,
      bookingData: null,
      transfer:    false,
    };
  }
}

// ── Generate one-line call summary for owner notification ──────
async function generateCallSummary(session) {
  const transcript = session.messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  if (!transcript.trim()) return 'Call with no conversation recorded';

  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages:   [{
        role:    'user',
        content: `Summarize this call in ONE sentence. Format: "[Outcome]: [What caller wanted] — [What was done]"\n\nTranscript:\n${transcript}`,
      }],
    });
    return response.content[0]?.text?.trim() || 'Call completed';
  } catch {
    return 'Call completed';
  }
}

module.exports = { getAIResponse, generateCallSummary };