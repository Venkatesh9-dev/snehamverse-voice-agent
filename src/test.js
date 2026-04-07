require('dotenv').config();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function test() {
  try {
    const msg = await client.messages.create({
      model:  "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [
        { role: "user", content: "Hello AI" }
      ],
    });

    console.log("✅ Claude Response:");
    console.log(msg.content[0].text);

  } catch (err) {
    console.error("❌ Error:");
    console.error(err.message);
  }
}

test(); 