// src/utils/checkEnv.js
// Run with: npm run test:env
// Validates all required environment variables before server starts

require('dotenv').config();

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'REDIS_URL',
  'BASE_URL',
  'ADMIN_API_KEY',
  'BUSINESS_NAME',
  'BUSINESS_TYPE',
  'OWNER_WHATSAPP',
  'HUMAN_TRANSFER_NUMBER',
];

const OPTIONAL_WITH_WARNING = [
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SHEETS_ID',
];

function checkEnv() {
  const missing = [];
  const warnings = [];

  for (const key of REQUIRED) {
    if (!process.env[key] || process.env[key].includes('your_') || process.env[key].includes('xxxxxxx')) {
      missing.push(key);
    }
  }

  for (const key of OPTIONAL_WITH_WARNING) {
    if (!process.env[key]) {
      warnings.push(key);
    }
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  Optional vars not set (Google Sheets logging disabled):\n   ${warnings.join(', ')}\n`);
  }

  if (missing.length > 0) {
    console.error(`\n❌ Missing required environment variables:\n   ${missing.join('\n   ')}\n`);
    console.error('Copy .env.example to .env and fill in all values.\n');
    process.exit(1);
  }

  // Validate BUSINESS_TYPE
  const validTypes = ['clinic', 'coaching', 'realestate', 'college'];
  if (!validTypes.includes(process.env.BUSINESS_TYPE)) {
    console.error(`\n❌ BUSINESS_TYPE must be one of: ${validTypes.join(', ')}\n`);
    process.exit(1);
  }

  console.log('✅ All environment variables are set correctly.\n');
}

checkEnv();
module.exports = { checkEnv };
