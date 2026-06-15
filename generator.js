'use strict';

require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');
const config = require('./config.json');

const responseCache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

const deepseekClient = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',

  async createMessage(messages, max_tokens = 512) {
    try {
      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model: this.model,
          messages: messages,
          max_tokens: max_tokens,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      return {
        content: [{ type: 'text', text: response.data.choices[0].message.content }]
      };
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      logger.error(`[deepseek] API error: ${errorMsg}`);
      throw new Error(`DeepSeek API error: ${errorMsg}`);
    }
  }
};

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

const STYLE_MAP = {
  question: 'casual check-in',
  statement: 'company update',
  followUp: 'follow-up on a previous conversation',
  casualCheckin: 'warm re-introduction',
  actionRequired: 'reminder about a pending task',
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickArchetype() {
  if (config.subjectStyles) {
    const styles = config.subjectStyles;
    const r = Math.random();
    let cumulative = 0;
    for (const [style, weight] of Object.entries(styles)) {
      cumulative += weight;
      if (r <= cumulative) {
        return STYLE_MAP[style] || pickRandom(ARCHETYPES);
      }
    }
  }
  return pickRandom(ARCHETYPES);
}

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      responseCache.delete(key);
    }
  }
}

async function generateEmail({ senderEmail, receiverEmail, senderNiche, receiverNiche }) {
  const archetype = pickArchetype();

  cleanCache();
  const cacheKey = `${senderEmail}->${receiverEmail}:${archetype}`;
  const cached = responseCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    logger.debug(`[generator] Cache hit for ${cacheKey}`);
    return cached.data;
  }

  const prompt = `Write a professional business email for me.

Context: I work in "${senderNiche}". I'm emailing someone in "${receiverNiche}".
Type: ${archetype}

MY WRITING STYLE — follow exactly:
- Sign the email with a realistic first name (James, Sarah, Michael, Priya, David, Lisa, etc). Do NOT invent a company name. Use "we" or "I" instead.
- Use proper spacing: blank line between greeting, each paragraph, and sign-off. Never one dense block.
- Keep paragraphs short: 1-2 sentences each, one idea per paragraph.
- Sound like a real person, not a template. Avoid "I hope this email finds you well" and other AI clichés.
- Conversational and low-pressure tone — not salesy, not overly formal.
- Vary sentence structure — don't start every sentence the same way.
- Vary your style across emails. Don't reuse the same phrases, structures, or parenthetical asides. Each email should feel unique.
- End with a natural sign-off on its own line (Thanks, / Best, / Talk soon,), then name on the next line.
- No filler: cut "Happy to share more", "Feel free to", "Just wanted to" unless they add real meaning.
- No buzzwords: synergy, leverage, scalability, ecosystem, cutting-edge, innovative.
- No mentions of AI, automation, or warmup.
- No [placeholders] or brackets.
- Length: 80-120 words.

Return ONLY valid JSON. No markdown fences. No extra text. Use \\n for newlines.
Format: {"subject":"subject here","body":"greeting\\n\\nparagraph one\\n\\nparagraph two\\n\\nsign-off\\nname"}`;

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const response = await deepseekClient.createMessage([
        { role: 'user', content: prompt }
      ]);

      const raw = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      let cleaned = raw.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
      cleaned = cleaned.replace(/\n?```\s*$/i, '');

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];

      cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');

      const parsed = JSON.parse(cleaned);

      if (!parsed.subject || !parsed.body) {
        throw new Error('Missing subject or body');
      }

      const result = {
        subject: String(parsed.subject).substring(0, 200),
        body: String(parsed.body).substring(0, 2000)
      };

      responseCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;

    } catch (err) {
      logger.warn(`[generator] Attempt ${attempts} failed: ${err.message}`);
      if (attempts >= 3) {
        logger.warn(`[generator] All retries exhausted, using fallback`);
        return {
          subject: `Quick question`,
          body: `Hi there,\n\nHope you're having a good week. I had a quick question I wanted to run by you when you have a moment.\n\nThanks,\nMichael`
        };
      }
      await sleep(2000 * attempts);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getCacheStats() {
  return {
    size: responseCache.size,
    keys: Array.from(responseCache.keys())
  };
}

module.exports = { generateEmail, getCacheStats };
