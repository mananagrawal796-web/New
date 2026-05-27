import { Client, GatewayIntentBits } from "discord.js";
import { GoogleGenAI } from "@google/genai";

// ─── Configuration ────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = "gemini-2.5-flash";

// Fail fast if env vars are missing
if (!DISCORD_TOKEN) throw new Error("Missing env var: DISCORD_TOKEN");
if (!GEMINI_API_KEY) throw new Error("Missing env var: GEMINI_API_KEY");

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Gemini client ─────────────────────────────────────────────────────────────
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ─── Chat session store ────────────────────────────────────────────────────────
// Key: channelId (or userId for DMs). Value: Gemini ChatSession instance.
const chatSessions = new Map();

/**
 * Returns an existing chat session for the given key, or creates a new one.
 * Using the Gemini SDK's native `startChat()` preserves conversational history
 * automatically without manual message-array management.
 *
 * @param {string} sessionKey - Unique key per channel or DM conversation.
 * @returns {import("@google/genai").Chat} Gemini chat session
 */
function getOrCreateSession(sessionKey) {
  if (!chatSessions.has(sessionKey)) {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const session = model.startChat({
      history: [],         // starts fresh; SDK appends turns automatically
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.9,
      },
      systemInstruction: {
        parts: [
          {
            text:
              "You are a helpful, friendly, and concise AI assistant living inside a Discord server. " +
              "Keep replies focused and avoid unnecessary padding. " +
              "When code is requested, use Discord-compatible markdown fences.",
          },
        ],
      },
    });
    chatSessions.set(sessionKey, session);
  }
  return chatSessions.get(sessionKey);
}

// ─── Utility helpers ────────────────────────────────────────────────────────────

/**
 * Splits a string into chunks ≤ maxLen characters, breaking on whitespace
 * where possible to avoid splitting mid-word.
 *
 * @param {string} text
 * @param {number} maxLen - Discord's hard limit is 2000 characters.
 * @returns {string[]}
 */
function splitIntoChunks(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxLen;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // Try to break on the last newline or space within the window
    const breakAt =
      text.lastIndexOf("\n", end) > start
        ? text.lastIndexOf("\n", end)
        : text.lastIndexOf(" ", end) > start
        ? text.lastIndexOf(" ", end)
        : end; // hard cut as last resort

    chunks.push(text.slice(start, breakAt).trimEnd());
    start = breakAt + 1; // skip the whitespace/newline we broke on
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Strips the bot's mention tag (e.g. <@123456789>) from the message content
 * and trims surrounding whitespace.
 *
 * @param {string} content - Raw message.content from Discord.
 * @param {string} botId   - The bot's user ID.
 * @returns {string}
 */
function cleanMention(content, botId) {
  // Discord can emit both <@ID> and <@!ID> (the ! was the old "nickname" form)
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

// ─── Event: ready ──────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
});

// ─── Event: messageCreate ──────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  // 1. Ignore the bot's own messages and other bots
  if (message.author.bot) return;

  // 2. Only respond when the bot is explicitly @mentioned
  if (!message.mentions.has(client.user.id)) return;

  // 3. Determine session key
  //    DMs have no guild, so use the author's ID to keep their DM context separate.
  const sessionKey = message.guild
    ? `guild:${message.guild.id}:channel:${message.channel.id}`
    : `dm:${message.author.id}`;

  // 4. Clean the user's prompt
  const userPrompt = cleanMention(message.content, client.user.id);

  if (!userPrompt) {
    await message.reply("Hey! Ask me anything. 😊");
    return;
  }

  // 5. Show a typing indicator while we wait for Gemini
  await message.channel.sendTyping();

  try {
    // 6. Send the message to the Gemini chat session
    const session  = getOrCreateSession(sessionKey);
    const result   = await session.sendMessage(userPrompt);
    const response = result.response.text();

    // 7. Chunk the response if it exceeds Discord's 2000-char limit
    const chunks = splitIntoChunks(response);

    // 8. Reply with the first chunk; send subsequent ones as follow-ups
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (error) {
    console.error("Error querying Gemini API:", error);

    // Surface a user-friendly error without leaking internals
    await message.reply(
      "⚠️ I ran into an error generating a response. Please try again in a moment."
    );
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
