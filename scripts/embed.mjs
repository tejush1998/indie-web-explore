import "dotenv/config";
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import OpenAI from "openai";
import * as lancedb from "@lancedb/lancedb";
import tiktoken from "tiktoken";
const { get_encoding } = tiktoken;

const enc = get_encoding("cl100k_base");

function countTokens(text) {
  try {
    return enc.encode(text, [], { disallowedSpecial: [] }).length;
  } catch {
    return Math.ceil(text.length / 2);
  }
}

function truncateToTokens(text, maxTokens) {
  let tokens;
  try {
    tokens = enc.encode(text, [], { disallowedSpecial: [] });
  } catch {
    return text.slice(0, maxTokens * 4);
  }
  if (tokens.length <= maxTokens) return text;
  return new TextDecoder().decode(enc.decode(tokens.slice(0, maxTokens)));
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DIMS = 512;
const MAX_TOKENS_PER_BATCH = 200_000; // API limit is 300K, keep generous buffer
const MAX_ARTICLES_PER_BATCH = 2000; // API limit is 2048 inputs

const START = Date.now();
const db = await lancedb.connect("indie-blog.lancedb");
const tableName = "articles";

let table;
let skip = 0;
const seenLinks = new Set();
try {
  table = await db.openTable(tableName);
  skip = await table.countRows();
  console.log(`Table exists with ${skip} rows, loading existing links for dedup...`);

  // Load all existing links into memory for dedup
  // Fetch in chunks since LanceDB search has a limit
  let offset = 0;
  const dims = (await table.schema()).fields.find(f => f.name === "vector").dim;
  while (offset < skip) {
    const batch = await table.search(Array(dims).fill(0)).limit(1000).offset(offset).toArray();
    for (const r of batch) {
      if (r.link) seenLinks.add(r.link);
    }
    offset += batch.length;
    if (batch.length === 0) break;
    if (offset % 5000 === 0) console.log(`  Loaded ${offset}/${skip} links`);
  }
  console.log(`  ${seenLinks.size} unique links loaded`);
} catch {
  console.log("Creating new table");
}

const parser = createReadStream("articles.csv").pipe(
  parse({ relax_column_count: true }),
);

async function embed(texts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
        dimensions: DIMS,
      });
      if (!resp?.data || resp.data.length !== texts.length) {
        if (attempt < 2) {
          console.error(`  Retry ${attempt + 1}: count mismatch`);
          continue;
        }
        throw new Error("count mismatch");
      }
      return resp.data.map((d) => d.embedding);
    } catch (e) {
      const delay = e.status === 429 ? 15000 : 2000;
      if (attempt < 2) {
        console.error(
          `  ${e.status === 429 ? "Rate limited" : "Error"} (attempt ${attempt + 1}), retrying in ${delay / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

async function embedAndStore(rows) {
  const texts = rows.map(
    (r) => truncateToTokens(r.text || "", 8000) || "(empty)",
  );
  const t1 = Date.now();
  const vectors = await embed(texts);

  const data = rows.map((r, i) => ({
    vector: vectors[i],
    feedUrl: r.feedUrl,
    feedTitle: r.feedTitle,
    title: r.title,
    link: r.link,
    pubDate: r.pubDate,
    text: r.text,
  }));

  if (!table) {
    table = await db.createTable(tableName, data, { mode: "create" });
  } else {
    await table.add(data);
  }

  console.log(
    `  ${rows.length} articles, ${Date.now() - t1}ms  (${Math.round((Date.now() - START) / 1000)}s elapsed)`,
  );
}

let lineNo = 0;
let batch = [];
let total = 0;
let estTokens = 0;

for await (const parts of parser) {
  lineNo++;
  if (lineNo === 1) continue;
  if (lineNo <= skip + 1) continue;
  if (parts.length < 6) continue;

  // Skip rows with no link (can't dedup, useless for search)
  if (!parts[3]) continue;

  // Skip duplicate links
  if (seenLinks.has(parts[3])) continue;
  seenLinks.add(parts[3]);

  const text = parts.slice(5).join(",");
  batch.push({
    feedUrl: parts[0],
    feedTitle: parts[1],
    title: parts[2],
    link: parts[3],
    pubDate: parts[4],
    text,
  });
  estTokens += countTokens(text);

  if (
    estTokens >= MAX_TOKENS_PER_BATCH ||
    batch.length >= MAX_ARTICLES_PER_BATCH
  ) {
    console.log(
      `[${Math.round((Date.now() - START) / 1000)}s] Batch  (${batch.length} articles)`,
    );
    await embedAndStore(batch);
    total += batch.length;
    batch = [];
    estTokens = 0;
  }
}

if (batch.length > 0) {
  console.log(
    `[${Math.round((Date.now() - START) / 1000)}s] Batch  (${batch.length} articles)`,
  );
  await embedAndStore(batch);
  total += batch.length;
}

console.log(`\nDone. ${skip + total} articles stored in indie-blog.lancedb`);
