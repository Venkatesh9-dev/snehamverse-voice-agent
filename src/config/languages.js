// src/config/languages.js
// Trilingual support — Hindi, Telugu, English
// Deepgram Nova-2 supports all three natively

const SUPPORTED_LANGUAGES = {
  english: {
    code: 'en',
    deepgramCode: 'en-IN',
    name: 'English',
    greeting: () => `Hello! Thank you for calling ${process.env.BUSINESS_NAME}. I'm your AI receptionist. How can I help you today?`,
    fallback: `I'm sorry, could you please repeat that?`,
    transferMessage: `Please hold while I connect you to our team.`,
    bookingConfirm: (name, time) => `Thank you ${name}! Your appointment request for ${time} has been noted. You'll receive a WhatsApp confirmation shortly. Have a great day!`,
    missedCallMsg: (businessName) => `Hi! You called ${businessName}. We're sorry we couldn't connect. Please reply with your name and preferred appointment time and we'll get back to you shortly.`,
    idleMessage: `Are you still there? If you need help, please speak now.`,
    timeoutMessage: `We haven't heard from you. Thank you for calling ${process.env.BUSINESS_NAME}. Please call again if you need assistance. Goodbye!`,
    ownerSummaryTemplate: (data) =>
      `📞 *New Call — ${data.businessName}*\n\n` +
      `👤 Caller: ${data.callerName || 'Unknown'}\n` +
      `📱 Phone: ${data.callerPhone}\n` +
      `🕐 Appointment: ${data.appointment || 'Not booked'}\n` +
      `🌐 Language: ${data.language}\n` +
      `⏱ Duration: ${data.duration}s\n` +
      `📋 Summary: ${data.summary}\n` +
      `✅ Outcome: ${data.outcome}`,
  },

  hindi: {
    code: 'hi',
    deepgramCode: 'hi',
    name: 'Hindi',
    greeting: () => `नमस्ते! ${process.env.BUSINESS_NAME} में आपका स्वागत है। मैं आपकी AI रिसेप्शनिस्ट हूं। आज मैं आपकी कैसे मदद कर सकती हूं?`,
    fallback: `माफ़ करें, क्या आप दोबारा बोल सकते हैं?`,
    transferMessage: `कृपया रुकिए, मैं आपको हमारी टीम से जोड़ रही हूं।`,
    bookingConfirm: (name, time) => `धन्यवाद ${name}! ${time} के लिए आपकी अपॉइंटमेंट रिक्वेस्ट नोट कर ली गई है। आपको WhatsApp पर कन्फर्मेशन मिलेगी। आपका दिन अच्छा हो!`,
    missedCallMsg: (businessName) => `नमस्ते! आपने ${businessName} को कॉल किया था। हम माफी चाहते हैं कि हम कनेक्ट नहीं हो पाए। कृपया अपना नाम और पसंदीदा अपॉइंटमेंट समय लिखकर भेजें।`,
    idleMessage: `क्या आप अभी भी लाइन पर हैं? यदि आपको मदद चाहिए तो कृपया बोलें।`,
    timeoutMessage: `हमें आपकी आवाज़ नहीं सुनाई दी। ${process.env.BUSINESS_NAME} को कॉल करने के लिए धन्यवाद। कृपया फिर से कॉल करें। शुक्रिया!`,
    ownerSummaryTemplate: (data) =>
      `📞 *नई कॉल — ${data.businessName}*\n\n` +
      `👤 कॉलर: ${data.callerName || 'अज्ञात'}\n` +
      `📱 फोन: ${data.callerPhone}\n` +
      `🕐 अपॉइंटमेंट: ${data.appointment || 'बुक नहीं हुई'}\n` +
      `🌐 भाषा: हिंदी\n` +
      `⏱ अवधि: ${data.duration}सेकंड\n` +
      `📋 सारांश: ${data.summary}\n` +
      `✅ परिणाम: ${data.outcome}`,
  },

  telugu: {
    code: 'te',
    deepgramCode: 'te',
    name: 'Telugu',
    greeting: () => `నమస్కారం! ${process.env.BUSINESS_NAME} కు కాల్ చేసినందుకు ధన్యవాదాలు. నేను మీ AI రిసెప్షనిస్ట్ ని. నేను మీకు ఎలా సహాయం చేయగలను?`,
    fallback: `క్షమించండి, మీరు మళ్ళీ చెప్పగలరా?`,
    transferMessage: `దయచేసి వేచి ఉండండి, నేను మిమ్మల్ని మా టీమ్ తో కనెక్ట్ చేస్తున్నాను.`,
    bookingConfirm: (name, time) => `ధన్యవాదాలు ${name}! ${time} కి మీ అపాయింట్మెంట్ రిక్వెస్ట్ నోట్ చేయబడింది. మీకు WhatsApp లో కన్ఫర్మేషన్ వస్తుంది. మీ రోజు శుభంగా గడవాలి!`,
    missedCallMsg: (businessName) => `నమస్కారం! మీరు ${businessName} కి కాల్ చేశారు. మేము కనెక్ట్ కాలేకపోయినందుకు క్షమించండి. దయచేసి మీ పేరు మరియు కావలసిన అపాయింట్మెంట్ సమయం పంపండి.`,
    idleMessage: `మీరు ఇంకా లైన్ లో ఉన్నారా? సహాయం కావాలంటే దయచేసి మాట్లాడండి.`,
    timeoutMessage: `మీ గొంతు వినిపించలేదు. ${process.env.BUSINESS_NAME} కి కాల్ చేసినందుకు ధన్యవాదాలు. మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు!`,
    ownerSummaryTemplate: (data) =>
      `📞 *కొత్త కాల్ — ${data.businessName}*\n\n` +
      `👤 కాలర్: ${data.callerName || 'తెలియదు'}\n` +
      `📱 ఫోన్: ${data.callerPhone}\n` +
      `🕐 అపాయింట్మెంట్: ${data.appointment || 'బుక్ కాలేదు'}\n` +
      `🌐 భాష: తెలుగు\n` +
      `⏱ వ్యవధి: ${data.duration}సెకన్లు\n` +
      `📋 సారాంశం: ${data.summary}\n` +
      `✅ ఫలితం: ${data.outcome}`,
  }
};

// Detect language from Deepgram metadata + Unicode fallback
function detectLanguage(deepgramLanguage, transcript = '') {
  if (deepgramLanguage) {
    if (deepgramLanguage.startsWith('hi')) return 'hindi';
    if (deepgramLanguage.startsWith('te')) return 'telugu';
    if (deepgramLanguage.startsWith('en')) return 'english';
  }
  // Unicode range fallback
  if (/[\u0C00-\u0C7F]/.test(transcript)) return 'telugu';
  if (/[\u0900-\u097F]/.test(transcript)) return 'hindi';
  return 'english';
}

function getLanguageConfig(langKey) {
  return SUPPORTED_LANGUAGES[langKey] || SUPPORTED_LANGUAGES.english;
}

module.exports = { SUPPORTED_LANGUAGES, detectLanguage, getLanguageConfig };
