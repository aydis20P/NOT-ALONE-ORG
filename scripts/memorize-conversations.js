#!/usr/bin/env node
/**
 * Memorize Conversations Service
 *
 * Run via cron to:
 * 1. Read all conversations that have a summary and are not yet memorized
 * 2. Create "memories" in the memories collection (per user, with first/last conversation dates)
 * 3. Detect significant moments and create documents in the "moments" collection
 * 4. Mark processed conversations as memorized (memorizedAt)
 *
 * Usage: node scripts/memorize-conversations.js
 * Cron example (daily at 2am): 0 2 * * * cd /path/to/project && node scripts/memorize-conversations.js
 *
 * Collections:
 *
 * - conversations: existing; gets memorizedAt (Date) set when processed.
 *
 * - memories: one doc per user per run, aggregating unmemorized summaries.
 *   { userId, createdAt, firstConversationAt, lastConversationAt, content, conversationIds }
 *
 * - moments: one doc per significant moment detected in a summary.
 *   { userId, createdAt, occurredAt, description, memoryId, conversationId }
 */

require('dotenv').config();
const { connectDB } = require('../db');
const { ObjectId } = require('mongodb');

const COLLECTIONS = {
  CONVERSATIONS: 'conversations',
  MEMORIES: 'memories',
  MOMENTS: 'moments',
};

/**
 * Fetch all conversations that have a summary and have not been memorized.
 * Returns array of conversation documents.
 */
async function getUnmemorizedConversations(db) {
  const conversations = db.collection(COLLECTIONS.CONVERSATIONS);
  const cursor = conversations.find({
    summary: { $exists: true, $ne: null, $ne: '' },
    $or: [
      { memorizedAt: { $exists: false } },
      { memorizedAt: null },
      { memorizedAt: false },
    ],
  }).sort({ finishedAt: 1 });
  return cursor.toArray();
}

/**
 * Group conversations by userId.
 * @param {Array} conversations
 * @returns {Record<string, Array>} userId -> conversations[]
 */
function groupByUser(conversations) {
  const byUser = {};
  for (const c of conversations) {
    const uid = (c.userId && c.userId.toString) ? c.userId.toString() : String(c.userId);
    if (!byUser[uid]) byUser[uid] = [];
    byUser[uid].push(c);
  }
  return byUser;
}

/**
 * Ask LLM if there is a significant moment in the summary; if so, return description and date.
 * @param {string} summary
 * @param {Date} conversationDate
 * @returns {Promise<{ description: string, occurredAt: Date } | null>}
 */
async function detectSignificantMoment(summary, conversationDate) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const dateStr = conversationDate ? conversationDate.toISOString().split('T')[0] : '';

  const prompt = `Analiza el siguiente resumen de una conversación en español.
Si hay un MOMENTO SIGNIFICATIVO (decisión importante, momento emocional clave, logro, conflicto relevante, cambio de perspectiva, algo que la persona recordaría como hito), responde ÚNICAMENTE con un JSON válido en una sola línea, sin markdown ni código:
{"significant": true, "description": "Una frase corta que describa el momento en español.", "occurredAt": "${dateStr}"}
Si NO hay un momento así de significativo, responde:
{"significant": false}

RESUMEN:
${summary}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Respondes solo con JSON válido, sin texto extra.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0.3,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!parsed.significant || !parsed.description) return null;

    const occurredAt = parsed.occurredAt
      ? new Date(parsed.occurredAt + 'T12:00:00.000Z')
      : conversationDate;

    return { description: parsed.description, occurredAt };
  } catch (e) {
    console.warn('detectSignificantMoment error:', e.message);
    return null;
  }
}

/**
 * Create one memory per user from their unmemorized conversations, and optional moments.
 * Then mark those conversations as memorized.
 */
async function processUserMemories(db, userId, userConversations) {
  const memoriesColl = db.collection(COLLECTIONS.MEMORIES);
  const momentsColl = db.collection(COLLECTIONS.MOMENTS);
  const conversationsColl = db.collection(COLLECTIONS.CONVERSATIONS);

  const conversationIds = userConversations.map((c) => c.conversationId);
  const summaries = userConversations.map((c) => c.summary).filter(Boolean);
  const content = summaries.join('\n\n');

  const dates = userConversations
    .map((c) => c.finishedAt || c.startedAt)
    .filter(Boolean)
    .map((d) => new Date(d));
  const firstConversationAt = dates.length ? new Date(Math.min(...dates)) : new Date();
  const lastConversationAt = dates.length ? new Date(Math.max(...dates)) : new Date();

  const memoryDoc = {
    userId: userId.length === 24 && /^[a-f0-9]+$/i.test(userId) ? new ObjectId(userId) : userId,
    createdAt: new Date(),
    firstConversationAt,
    lastConversationAt,
    content,
    conversationIds,
  };

  const { insertedId: memoryId } = await memoriesColl.insertOne(memoryDoc);

  // Check each conversation for a significant moment and create moments
  let momentsCreated = 0;
  for (const conv of userConversations) {
    const convDate = conv.finishedAt ? new Date(conv.finishedAt) : conv.startedAt ? new Date(conv.startedAt) : new Date();
    const moment = await detectSignificantMoment(conv.summary || '', convDate);
    if (moment) {
      await momentsColl.insertOne({
        userId: memoryDoc.userId,
        createdAt: new Date(),
        occurredAt: moment.occurredAt,
        description: moment.description,
        memoryId,
        conversationId: conv.conversationId,
      });
      momentsCreated++;
    }
  }

  // Mark all these conversations as memorized
  await conversationsColl.updateMany(
    { conversationId: { $in: conversationIds } },
    { $set: { memorizedAt: new Date() } }
  );

  return { memoryId, conversationIds, momentsCreated };
}

async function run() {
  console.log('[memorize-conversations] Starting...');
  const db = await connectDB();

  const unmemorized = await getUnmemorizedConversations(db);
  if (!unmemorized.length) {
    console.log('[memorize-conversations] No unmemorized conversations with summaries. Done.');
    return;
  }

  console.log(`[memorize-conversations] Found ${unmemorized.length} unmemorized conversation(s).`);
  const byUser = groupByUser(unmemorized);

  for (const [userId, conversations] of Object.entries(byUser)) {
    try {
      const result = await processUserMemories(db, userId, conversations);
      console.log(`[memorize-conversations] User ${userId}: 1 memory, ${result.momentsCreated} moment(s), ${conversations.length} conversation(s) marked memorized.`);
    } catch (err) {
      console.error(`[memorize-conversations] Error processing user ${userId}:`, err);
    }
  }

  console.log('[memorize-conversations] Finished.');
}

run().catch((err) => {
  console.error('[memorize-conversations] Fatal error:', err);
  process.exit(1);
});
