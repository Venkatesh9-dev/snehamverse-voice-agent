// src/config/languages.js
// Trilingual support — Hindi, Telugu, English
// FIX: greetings shortened to 1 sentence — less robotic, caller can speak sooner
// Deepgram Nova-2 supports all three natively

const SUPPORTED_LANGUAGES = {
  english: {
    code: 'en',
    deepgramCode: 'en-IN',
    name: 'English',
    greeting: () => `Hi, thanks for calling ${process.env.BUSINESS_NAME} — I'm Ammu, how can I help you today?`,
    fallback: `I'm sorry, could you please repeat that?`,
    transferMessage: `Please hold, I'm connecting you to our team right away.`,
    bookingConfirm: (name, time) => `Thank you ${name}! Your request for ${time} is noted — you'll get a WhatsApp confirmation shortly.`,
    missedCallMsg: (businessName) => `Hi! You called ${businessName}. Sorry we missed you — reply with your name and preferred time and we'll get back to you.`,
    idleMessage: `Are you still there? Please go ahead whenever you're ready.`,
    timeoutMessage: `Thanks for calling ${process.env.BUSINESS_NAME} — please call us again anytime. Goodbye!`,
    ownerSummaryTemplate: (data) =>
      `📞 *New Call — ${data.businessName}*\n\n` +
      `👤 Caller: ${data.callerName || 'Unknown'}\n` +
      `📱 Phone: ${data.callerPhone}\n` +
      `🕐 Booking: ${data.appointment || 'Not booked'}\n` +
      `🌐 Language: ${data.language}\n` +
      `⏱ Duration: ${data.duration}s\n` +
      `📋 Summary: ${data.summary}\n` +
      `✅ Outcome: ${data.outcome}`,
  },

  hindi: {
    code: 'hi',
    deepgramCode: 'hi',
    name: 'Hindi',
    greeting: () => `नमस्ते, ${process.env.BUSINESS_NAME} में आपका स्वागत है — मैं अम्मू हूं, बताइए मैं आपकी कैसे मदद करूं?`,
    fallback: `माफ़ करें, क्या आप दोबारा बोल सकते हैं?`,
    transferMessage: `रुकिए, मैं आपको अभी हमारी टीम से जोड़ रही हूं।`,
    bookingConfirm: (name, time) => `धन्यवाद ${name}! ${time} के लिए आपकी रिक्वेस्ट नोट हो गई — WhatsApp पर कन्फर्मेशन आएगी।`,
    missedCallMsg: (businessName) => `नमस्ते! आपने ${businessName} को कॉल किया था। अपना नाम और समय भेजें, हम जल्द संपर्क करेंगे।`,
    idleMessage: `क्या आप अभी भी लाइन पर हैं? कृपया बोलें।`,
    timeoutMessage: `${process.env.BUSINESS_NAME} को कॉल करने के लिए शुक्रिया — कभी भी दोबारा कॉल करें। शुक्रिया!`,
    ownerSummaryTemplate: (data) =>
      `📞 *नई कॉल — ${data.businessName}*\n\n` +
      `👤 कॉलर: ${data.callerName || 'अज्ञात'}\n` +
      `📱 फोन: ${data.callerPhone}\n` +
      `🕐 बुकिंग: ${data.appointment || 'बुक नहीं हुई'}\n` +
      `🌐 भाषा: हिंदी\n` +
      `⏱ अवधि: ${data.duration}s\n` +
      `📋 सारांश: ${data.summary}\n` +
      `✅ परिणाम: ${data.outcome}`,
  },

  telugu: {
    code: 'te',
    deepgramCode: 'te',
    name: 'Telugu',
    greeting: () => `నమస్కారం, ${process.env.BUSINESS_NAME} కి కాల్ చేసినందుకు ధన్యవాదాలు — నేను అమ్ము, మీకు ఎలా సహాయం చేయగలను?`,
    fallback: `క్షమించండి, మీరు మళ్ళీ చెప్పగలరా?`,
    transferMessage: `దయచేసి వేచి ఉండండి, నేను మిమ్మల్ని మా టీమ్ తో కనెక్ట్ చేస్తున్నాను.`,
    bookingConfirm: (name, time) => `ధన్యవాదాలు ${name}! ${time} కి మీ రిక్వెస్ట్ నోట్ అయింది — WhatsApp లో కన్ఫర్మేషన్ వస్తుంది.`,
    missedCallMsg: (businessName) => `నమస్కారం! మీరు ${businessName} కి కాల్ చేశారు. మీ పేరు మరియు సమయం పంపండి, మేము తిరిగి కాల్ చేస్తాము.`,
    idleMessage: `మీరు ఇంకా లైన్ లో ఉన్నారా? దయచేసి మాట్లాడండి.`,
    timeoutMessage: `${process.env.BUSINESS_NAME} కి కాల్ చేసినందుకు ధన్యవాదాలు — మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు!`,
    ownerSummaryTemplate: (data) =>
      `📞 *కొత్త కాల్ — ${data.businessName}*\n\n` +
      `👤 కాలర్: ${data.callerName || 'తెలియదు'}\n` +
      `📱 ఫోన్: ${data.callerPhone}\n` +
      `🕐 బుకింగ్: ${data.appointment || 'బుక్ కాలేదు'}\n` +
      `🌐 భాష: తెలుగు\n` +
      `⏱ వ్యవధి: ${data.duration}s\n` +
      `📋 సారాంశం: ${data.summary}\n` +
      `✅ ఫలితం: ${data.outcome}`,
  }
};

// Detect language from Deepgram metadata + Unicode script fallback
function detectLanguage(deepgramLanguage, transcript = '') {
  if (deepgramLanguage) {
    if (deepgramLanguage.startsWith('hi')) return 'hindi';
    if (deepgramLanguage.startsWith('te')) return 'telugu';
    if (deepgramLanguage.startsWith('en')) return 'english';
  }
  // Unicode range fallback — catches cases where Deepgram doesn't return language
  if (/[\u0C00-\u0C7F]/.test(transcript)) return 'telugu';
  if (/[\u0900-\u097F]/.test(transcript)) return 'hindi';
  return 'english';
}

function getLanguageConfig(langKey) {
  return SUPPORTED_LANGUAGES[langKey] || SUPPORTED_LANGUAGES.english;
}

module.exports = { SUPPORTED_LANGUAGES, detectLanguage, getLanguageConfig };