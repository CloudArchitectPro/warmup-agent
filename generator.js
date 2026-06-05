'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARCHETYPES = [
  'casual check-in',
  'follow-up on a previous conversation',
  'product or service inquiry',
  'company update',
  'request for a call',
  'warm re-introduction',
  'congratulatory note',
  'referral or recommendation request',
  'light business development outreach',
  'reminder about a pending task',
];

function inferFirstName(email) {
  // e.g. "alice@example.com" → "Alice"
  const local = email.split('@')[0];
  const base = local.replace(/[^a-zA-Z]/g, '');
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateEmail({ senderEmail, receiverEmail, senderNiche, receiverNiche }) {
  const archetype = pickRandom(ARCHETYPES);
  const senderName = inferFirstName(senderEmail) || 'there';
  const receiverName = inferFirstName(receiverEmail) || 'there';

  const prompt = `You are writing a real business email on behalf of ${senderName} (${senderEmail}) to ${receiverName} (${receiverEmail}).

Sender's business context: ${senderNiche}
Receiver's business context: ${receiverNiche}
Email archetype: ${archetype}

Rules:
- Write a natural, human-sounding business email
- Length: 60–200 words
- Vary the greeting style (Hi, Hey, Hello, Good morning, etc.)
- Vary the sign-off (Best, Cheers, Thanks, Warm regards, Talk soon, etc.)
- Use the inferred first names for greeting and sign-off — never use placeholder brackets like [Name]
- The tone should be professional but casual and warm — like two people who know each other in a business context
- NEVER mention warm-up, deliverability, automation, AI, or anything meta about email sending
- Make the content feel specific and relevant to both businesses

Respond ONLY with a valid JSON object in this exact format (no markdown, no code fences, no extra text):
{"subject": "...", "body": "..."}`;

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      const raw = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Strip markdown code fences if present
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(cleaned);

      if (!parsed.subject || !parsed.body) {
        throw new Error('Missing subject or body in response');
      }

      return { subject: String(parsed.subject), body: String(parsed.body) };
    } catch (err) {
      logger.warn(`[generator] Attempt ${attempts} failed: ${err.message}`);
      if (attempts >= 3) {
        throw new Error(`[generator] Failed to generate email after 3 attempts: ${err.message}`);
      }
      await sleep(2000 * attempts);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { generateEmail };
