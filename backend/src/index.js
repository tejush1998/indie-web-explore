import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import * as lancedb from "@lancedb/lancedb";
import crypto from "node:crypto";
import path from "path";

// Clients: OpenAI for embeddings, OpenRouter for chat
const embedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chatClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

function hasContent(text) {
  if (!text) return false;
  const words = text.replace(/[^\w\s]/g, " ").match(/\S+/g);
  return words ? words.length >= 8 : false;
}

const DIMS = 512;
const PORT = process.env.PORT || 3000;
const dbPath = path.resolve(process.cwd(), "data/indie-blog.lancedb");

const db = await lancedb.connect(dbPath);
let table,
  totalRows = 0;
try {
  table = await db.openTable("articles");
  totalRows = await table.countRows();
} catch {
  console.log("No articles yet — embed.mjs hasn't finished or started");
}

function format(r) {
  return {
    title:
      r.title ||
      r.text?.slice(0, 120) ||
      r.link?.split("/").pop() ||
      "(untitled)",
    link: r.link,
    feedTitle: r.feedTitle,
    feedUrl: r.feedUrl,
    pubDate: r.pubDate,
    excerpt: (r.text || "").slice(0, 300).replace(/\n/g, " "),
    score: (r._distance || 0).toFixed(3),
  };
}

async function searchTable(queryVector, targetLimit) {
  if (!table) return [];
  const fetch = Math.min(targetLimit * 5, 500);
  const raw = await table.search(queryVector).limit(fetch).toArray();
  const filtered = raw.filter((r) => hasContent(r.text));
  return filtered.slice(0, targetLimit).map(format);
}

async function searchQueries(queries, perQuery = 8) {
  const resp = await embedClient.embeddings.create({
    model: "text-embedding-3-small",
    input: queries.map((s) => s.trim().slice(0, 1000)),
    dimensions: DIMS,
  });
  const all = [];
  for (let i = 0; i < resp.data.length; i++) {
    all.push(...(await searchTable(resp.data[i].embedding, perQuery)));
  }
  const seen = new Set();
  return all
    .filter((r) => {
      if (seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    })
    .slice(0, 15);
}

// Session store
const sessions = new Map();

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { history: [], questionCount: 0 };
    sessions.set(sessionId, s);
  }
  return s;
}

const SYSTEM_PROMPT = `You are a warm, curious curator for the Indie Web — a collection of hundreds of thousands of personal blog posts. Your job is to help people discover something surprising and meaningful.

Your personality:
- Warm, genuine, slightly playful. You love the weird and wonderful corners of the internet.
- You ask ONE question at a time. Never multiple.
- You ask 2–4 clarifying questions before you're ready to search.
- When you feel you understand what they're after, you generate search queries and deliver results.

Respond in JSON only, using one of these formats:

When asking a question:
{"action": "ask", "message": "your question here"}

When ready to search:
{"action": "search", "message": "a short, excited intro to the results", "queries": ["query 1", "query 2", "query 3"]}

The queries should be diverse angles on what the user is looking for — interpret the query broadly across all its possible meanings and connotations. Use simple everyday language. Each query should be 3–10 words, natural language phrases that would appear in blog posts.

Always respond with valid JSON. No markdown. No code fences.`;

const app = express();
app.use(express.static("frontend"));
app.use(express.json());

app.get("/api/stats", async (_, res) => {
  let count = 0;
  try {
    count = await (await db.openTable("articles")).countRows();
  } catch {}
  res.json({ articles: count });
});

app.post("/api/search", async (req, res) => {
  const { q, limit = 20 } = req.body;
  if (!q || !q.trim()) return res.json({ results: [] });

  const resp = await embedClient.embeddings.create({
    model: "text-embedding-3-small",
    input: q,
    dimensions: DIMS,
  });

  const results = await searchTable(resp.data[0].embedding, limit);
  res.json({ results });
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, skipQuestions } = req.body;
  if (!message || !message.trim())
    return res.json({ action: "ask", message: "What's on your mind?" });

  const sid = sessionId || crypto.randomUUID();
  const session = getSession(sid);

  session.history.push({ role: "user", content: message });

  // If the user clicked an option or asked to skip chat, force search
  let forceSearch = session.questionCount >= 3 || skipQuestions;

  let systemMsg = SYSTEM_PROMPT;
  if (forceSearch) {
    systemMsg = SYSTEM_PROMPT.replace(
      "You ask 2–4 clarifying questions before you're ready to search.",
      "You have already asked enough questions. Respond with a search action now.",
    );
  }

  const resp = await chatClient.chat.completions.create({
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "system", content: systemMsg }, ...session.history],
    max_tokens: 500,
  });

  const raw = resp.choices[0].message.content;
  let decision;
  try {
    decision = JSON.parse(raw.replace(/```json\s*|```/g, "").trim());
  } catch {
    decision = { action: "ask", message: raw };
  }

  if (decision.action === "search" || forceSearch) {
    const queries = decision.queries?.filter((q) => q?.trim()) || [];
    if (queries.length === 0) queries.push(message);
    session.history.push({
      role: "assistant",
      content: `[Searched for: ${queries.join(", ")}]`,
    });
    const results = await searchQueries(queries);

    // Generate follow-up suggestions based on what was found
    let followUps = [];
    try {
      const fu = await chatClient.chat.completions.create({
        model: "deepseek/deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content:
              "You are a curator. Suggest 3 follow-up directions that each explore a completely different angle of the user's query. Use simple everyday language — short phrases of 2–5 words. No jargon, no academic vocabulary. Think of how a friend would describe something interesting. Prioritize diversity over relevance. Return a JSON array of strings only.",
          },
          {
            role: "user",
            content: `Query: "${message}"\n\nArticles found:\n${results
              .slice(0, 5)
              .map((r) => `- ${r.title}`)
              .join("\n")}`,
          },
        ],
        max_tokens: 200,
      });
      const raw = fu.choices[0].message.content;
      followUps = JSON.parse(raw.replace(/```json\s*|```/g, "").trim());
    } catch {} // graceful fallback — no suggestions
    res.json({
      action: "results",
      sessionId: sid,
      message: decision.message,
      queries: decision.queries,
      results,
      followUps,
    });
  } else {
    session.questionCount++;
    session.history.push({ role: "assistant", content: decision.message });
    res.json({
      action: "ask",
      sessionId: sid,
      message: decision.message,
    });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
