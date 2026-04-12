// src/config/languages.js
// Ammu — SnehAmverseAI Voice Receptionist
// Telugu, Hindi, English — natural Indian warmth
// Greetings: short, warm, conversational — not scripted

const SUPPORTED_LANGUAGES = {

  english: {
    code:         'en',
    deepgramCode: 'en-IN',
    name:         'English',

    // Short, warm, natural — caller can speak within 3 seconds
    greeting: () => `Hi! I'm Ammu from ${process.env.BUSINESS_NAME || 'SnehAmverseAI'} — how can I help you today?`,

    fallback:       `Sorry about that, could you say that again?`,
    transferMessage: `Of course, let me connect you to our team right away — please hold for a moment.`,

    bookingConfirm: (name, time) =>
      `Thank you ${name}! I've noted your details — our team will reach out within 24 hours. Have a wonderful day!`,

    missedCallMsg: (businessName) =>
      `Hi! You called ${businessName}. Sorry we missed you! Reply with your name and what you need and we'll get back to you soon.`,

    idleMessage:    `Are you still there? Take your time — I'm here whenever you're ready.`,

    timeoutMessage: `Thanks so much for calling ${process.env.BUSINESS_NAME || 'SnehAmverseAI'} — do call us again anytime. Have a great day!`,

    ownerSummaryTemplate: (data) =>
      `📞 *New Call — ${data.businessName}*\n\n` +
      `👤 Caller: ${data.callerName || 'Unknown'}\n` +
      `🏢 Institution: ${data.institution || 'Not provided'}\n` +
      `📱 Phone: ${data.callerPhone}\n` +
      `🎯 Interest: ${data.interest || data.appointment || 'Not specified'}\n` +
      `🌐 Language: ${data.language}\n` +
      `⏱ Duration: ${data.duration}s\n` +
      `📋 Summary: ${data.summary}\n` +
      `✅ Outcome: ${data.outcome}`,
  },

  hindi: {
    code:         'hi',
    deepgramCode: 'hi',
    name:         'Hindi',

    greeting: () => `नमस्ते! मैं अम्मू हूं, ${process.env.BUSINESS_NAME || 'SnehAmverseAI'} से — बताइए, मैं आपकी कैसे मदद करूं?`,

    fallback:       `माफ़ करें, क्या आप दोबारा बोल सकते हैं?`,
    transferMessage: `बिल्कुल, मैं अभी आपको हमारी टीम से जोड़ रही हूं — एक पल रुकिए।`,

    bookingConfirm: (name, time) =>
      `शुक्रिया ${name}! आपकी जानकारी नोट हो गई — हमारी टीम 24 घंटे में आपसे संपर्क करेगी। आपका दिन शुभ हो!`,

    missedCallMsg: (businessName) =>
      `नमस्ते! आपने ${businessName} को कॉल किया था। हम मिस कर गए — अपना नाम और जरूरत लिखकर भेजें, हम जल्द संपर्क करेंगे।`,

    idleMessage:    `क्या आप अभी भी लाइन पर हैं? कोई बात नहीं, जब चाहें बोलें।`,

    timeoutMessage: `${process.env.BUSINESS_NAME || 'SnehAmverseAI'} को कॉल करने के लिए शुक्रिया — कभी भी दोबारा कॉल करें। धन्यवाद!`,

    ownerSummaryTemplate: (data) =>
      `📞 *नई कॉल — ${data.businessName}*\n\n` +
      `👤 कॉलर: ${data.callerName || 'अज्ञात'}\n` +
      `🏢 संस्थान: ${data.institution || 'नहीं बताया'}\n` +
      `📱 फोन: ${data.callerPhone}\n` +
      `🎯 रुचि: ${data.interest || data.appointment || 'नहीं बताया'}\n` +
      `🌐 भाषा: हिंदी\n` +
      `⏱ अवधि: ${data.duration}s\n` +
      `📋 सारांश: ${data.summary}\n` +
      `✅ परिणाम: ${data.outcome}`,
  },

  telugu: {
    code:         'te',
    deepgramCode: 'te',
    name:         'Telugu',

    greeting: () => `నమస్కారం! నేను అమ్ము, ${process.env.BUSINESS_NAME || 'SnehAmverseAI'} నుండి — మీకు ఎలా సహాయం చేయగలను?`,

    fallback:       `క్షమించండి, మీరు మళ్ళీ చెప్పగలరా?`,
    transferMessage: `అలాగే, నేను ఇప్పుడే మిమ్మల్ని మా టీమ్‌తో కనెక్ట్ చేస్తున్నాను — దయచేసి ఒక్క నిమిషం వేచి ఉండండి.`,

    bookingConfirm: (name, time) =>
      `ధన్యవాదాలు ${name}! మీ వివరాలు నమోదు అయ్యాయి — మా టీమ్ 24 గంటల్లో మీకు కాల్ చేస్తారు. మీ రోజు శుభంగా గడవాలి!`,

    missedCallMsg: (businessName) =>
      `నమస్కారం! మీరు ${businessName} కి కాల్ చేశారు. మేము మిస్ అయ్యాము — మీ పేరు మరియు అవసరం పంపండి, మేము త్వరగా తిరిగి కాల్ చేస్తాము.`,

    idleMessage:    `మీరు ఇంకా లైన్‌లో ఉన్నారా? పరవాలేదు, మీకు సిద్ధంగా ఉన్నప్పుడు మాట్లాడండి.`,

    timeoutMessage: `${process.env.BUSINESS_NAME || 'SnehAmverseAI'} కి కాల్ చేసినందుకు ధన్యవాదాలు — మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు!`,

    ownerSummaryTemplate: (data) =>
      `📞 *కొత్త కాల్ — ${data.businessName}*\n\n` +
      `👤 కాలర్: ${data.callerName || 'తెలియదు'}\n` +
      `🏢 సంస్థ: ${data.institution || 'చెప్పలేదు'}\n` +
      `📱 ఫోన్: ${data.callerPhone}\n` +
      `🎯 ఆసక్తి: ${data.interest || data.appointment || 'చెప్పలేదు'}\n` +
      `🌐 భాష: తెలుగు\n` +
      `⏱ వ్యవధి: ${data.duration}s\n` +
      `📋 సారాంశం: ${data.summary}\n` +
      `✅ ఫలితం: ${data.outcome}`,
  },
};

// ── Language detection — Deepgram first, Unicode fallback ─────
function detectLanguage(deepgramLanguage, transcript = '') {
  // Trust Deepgram's detection first
  if (deepgramLanguage) {
    if (deepgramLanguage.startsWith('hi')) return 'hindi';
    if (deepgramLanguage.startsWith('te')) return 'telugu';
    if (deepgramLanguage.startsWith('en')) return 'english';
  }
  // Unicode script range fallback
  if (/[\u0C00-\u0C7F]/.test(transcript)) return 'telugu'; // Telugu script
  if (/[\u0900-\u097F]/.test(transcript)) return 'hindi';  // Devanagari
  return 'english';
}

function getLanguageConfig(langKey) {
  return SUPPORTED_LANGUAGES[langKey] || SUPPORTED_LANGUAGES.english;
}

module.exports = { SUPPORTED_LANGUAGES, detectLanguage, getLanguageConfig };
