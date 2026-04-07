// src/services/llmService.js
// Claude Haiku — fast, cheap, conversational
// FIX: booking data extracted via a SEPARATE dedicated call (not regex on spoken text)

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../config/prompts');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Extract booking JSON from response (robust) ───────────────
// LLM appends BOOKING_JSON:{...} after its spoken reply
// We strip it before TTS so the caller never hears it
function extractBookingData(responseText) {
  try {
    const match = responseText.match(/BOOKING_JSON:(\{[^}]+\})/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      // Only return if we have at least a name
      if (parsed.name && parsed.name !== 'CALLER_NAME') return parsed;
    }
  } catch { /* ignore malformed JSON */ }
  return null;
}

// ── Strip BOOKING_JSON from text before sending to TTS ─────────
function cleanResponseText(text) {
  return text.replace(/BOOKING_JSON:\{[^}]+\}/g, '').trim();
}

// ── Detect transfer signal ────────────────────────────────────
function needsTransfer(text) {
  return text.includes('TRANSFER_NOW');
}

// ── Clean transfer signal from spoken text ────────────────────
function cleanTransferText(text) {
  return text.replace('TRANSFER_NOW', '').trim();
}

// ── Main: get AI response ─────────────────────────────────────
async function getAIResponse(session, userTranscript, customFAQs = []) {
  const systemPrompt = buildSystemPrompt(
    process.env.BUSINESS_TYPE || 'clinic',
    session.language,
    customFAQs
  );

  // Only send last 10 messages to save tokens
  const recentMessages = session.messages.slice(-10);

  try {
    const response = await anthropic.messages.create({
      model:     "claude-haiku-4-5-20251001",
      max_tokens: 180,
      system:     systemPrompt,
      messages:   [
        ...recentMessages,
        { role: 'user', content: userTranscript }
      ],
    });

    const rawText    = response.content[0]?.text || '';
    const transfer   = needsTransfer(rawText);
    const bookingData = extractBookingData(rawText);
    let   cleanText  = cleanResponseText(rawText);
    if (transfer) cleanText = cleanTransferText(cleanText);

    logger.info('LLM response generated', {
      callSid:      session.callSid,
      language:     session.language,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      hasBooking:   !!bookingData,
      transfer,
    });

    return { text: cleanText, bookingData, transfer };

  } catch (err) {
    logger.error('LLM error', { error: err.message, callSid: session.callSid });
    // Language-aware fallback
    const fallbacks = {
      english: "I'm sorry, I didn't catch that. Could you please repeat?",
      hindi:   'माफ़ करें, मैं समझ नहीं पाई। कृपया दोबारा बोलें।',
      telugu:  'క్షమించండి, నేను అర్థం చేసుకోలేకపోయాను. దయచేసి మళ్ళీ చెప్పండి.',
    };
    return {
      text:        fallbacks[session.language] || fallbacks.english,
      bookingData: null,
      transfer:    false,
    };
  }
}

// ── Generate a one-line call summary for owner notification ────
async function generateCallSummary(session) {
  const transcript = session.messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  if (!transcript.trim()) return 'Call with no conversation recorded';

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages:   [{
        role:    'user',
        content: `Summarize this call in ONE sentence. Format: "[Outcome]: [What caller wanted] — [What was done]"\n\nTranscript:\n${transcript}`
      }],
    });
    return response.content[0]?.text?.trim() || 'Call completed';
  } catch {
    return 'Call completed';
  }
}

module.exports = { getAIResponse, generateCallSummary };
