/**
 * Capture sticker/emoji set responses from official Telegram servers.
 * Downloads everything in parallel for speed.
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_sticker_sets.mjs
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const API_ID = parseInt(process.env.TG_API_ID || "2496");
const API_HASH = process.env.TG_API_HASH || "8da85b0d5bfe62527e5b244c209159c3";
const SESSION_STRING = process.env.TG_SESSION || "";
const PARALLEL_DOWNLOADS = 10; // concurrent file downloads
const PARALLEL_SETS = 5;       // concurrent getStickerSet requests

if (!SESSION_STRING) {
  console.error("Set TG_SESSION environment variable");
  process.exit(1);
}

const DATA_DIR = resolve(process.cwd(), "..", "self_hosted_version", "data");
const FILES_DIR = join(DATA_DIR, "files");
const STICKER_SETS_DIR = join(DATA_DIR, "sticker_sets");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function ser(obj, depth = 0) {
  if (depth > 12) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return { __type: "Buffer", hex: obj.toString("hex").slice(0, 256) };
  if (obj instanceof Uint8Array) return { __type: "Buffer", hex: Buffer.from(obj).toString("hex").slice(0, 256) };
  if (Array.isArray(obj)) return obj.map((x) => ser(x, depth + 1));
  const r = {};
  if (obj.className) r.__className = obj.className;
  if (obj.CONSTRUCTOR_ID !== undefined) r.__constructorId = obj.CONSTRUCTOR_ID >>> 0;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_") || key === "CONSTRUCTOR_ID" || key === "SUBCLASS_OF_ID" || key === "classType") continue;
    try { r[key] = ser(obj[key], depth + 1); } catch { r[key] = "[error]"; }
  }
  return r;
}

// Run tasks with concurrency limit
async function parallel(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function downloadDoc(client, doc) {
  if (!doc || !doc.id) return false;
  const docId = doc.id.toString();
  const outPath = join(FILES_DIR, docId);
  if (existsSync(outPath)) return false;
  try {
    const buffer = await client.downloadMedia(doc, {});
    if (buffer && buffer.length > 0) {
      writeFileSync(outPath, buffer);
      return true;
    }
  } catch {}
  return false;
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(FILES_DIR);
  ensureDir(STICKER_SETS_DIR);

  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    deviceModel: "Telegram Web A",
    systemVersion: "Mac OS X 10.15.7",
    appVersion: "2.1.3 K",
    langCode: "en",
    systemLangCode: "en",
  });

  await client.start({
    phoneNumber: async () => { throw new Error("Session expired"); },
    password: async () => { throw new Error("Session expired"); },
    phoneCode: async () => { throw new Error("Session expired"); },
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("✅ Connected\n");

  // ── 1. Fetch metadata in parallel ─────────────────────────────────
  console.log("📡 Fetching emoji stickers & featured sets...");
  const [emojiStickers, featured] = await Promise.all([
    client.invoke(new Api.messages.GetEmojiStickers({ hash: BigInt(0) })),
    client.invoke(new Api.messages.GetFeaturedEmojiStickers({ hash: BigInt(0) })),
  ]);

  // Save emoji_stickers
  const esBytes = emojiStickers.getBytes();
  writeFileSync(join(DATA_DIR, "emoji_stickers.bin"), esBytes);
  writeFileSync(join(DATA_DIR, "emoji_stickers.json"), JSON.stringify(ser(emojiStickers), null, 2));
  const emojiSetCount = emojiStickers.sets?.length || 0;
  console.log(`✅ emoji_stickers.bin: ${esBytes.length} bytes (${emojiSetCount} sets)`);

  // Save featured_emoji_stickers
  const fBytes = featured.getBytes();
  writeFileSync(join(DATA_DIR, "featured_emoji_stickers.bin"), fBytes);
  writeFileSync(join(DATA_DIR, "featured_emoji_stickers.json"), JSON.stringify(ser(featured), null, 2));
  const featuredSets = featured.sets?.map(c => c.set) || [];
  console.log(`✅ featured_emoji_stickers.bin: ${fBytes.length} bytes (${featuredSets.length} sets)`);

  // ── 2. Fetch full sticker sets in parallel ────────────────────────
  console.log(`\n📦 Fetching ${featuredSets.length} full sticker sets (${PARALLEL_SETS} concurrent)...`);
  let allDocs = [];
  let setsCompleted = 0;

  const setTasks = featuredSets.map((s) => async () => {
    try {
      const fullSet = await client.invoke(new Api.messages.GetStickerSet({
        stickerset: new Api.InputStickerSetID({ id: s.id, accessHash: s.accessHash }),
        hash: 0,
      }));
      const raw = fullSet.getBytes();
      writeFileSync(join(STICKER_SETS_DIR, `${s.id}.bin`), raw);
      writeFileSync(join(STICKER_SETS_DIR, `${s.id}.json`), JSON.stringify(ser(fullSet), null, 2));
      const docs = fullSet.documents || [];
      allDocs.push(...docs);
      setsCompleted++;
      process.stdout.write(`\r  Sets: ${setsCompleted}/${featuredSets.length} | Docs queued: ${allDocs.length}`);
    } catch (e) {
      setsCompleted++;
      console.error(`\n  ❌ Set "${s.title}" (${s.id}): ${e.message}`);
    }
  });

  await parallel(setTasks, PARALLEL_SETS);
  console.log(`\n✅ ${setsCompleted} sets fetched, ${allDocs.length} documents to download`);

  // ── 3. Download all document files in parallel ────────────────────
  // Deduplicate by doc id
  const seen = new Set();
  const uniqueDocs = [];
  for (const doc of allDocs) {
    if (!doc?.id) continue;
    const key = doc.id.toString();
    if (seen.has(key)) continue;
    if (existsSync(join(FILES_DIR, key))) continue;
    seen.add(key);
    uniqueDocs.push(doc);
  }

  console.log(`\n📥 Downloading ${uniqueDocs.length} new documents (${PARALLEL_DOWNLOADS} concurrent)...`);
  let downloaded = 0;
  let failed = 0;
  const startTime = Date.now();

  const downloadTasks = uniqueDocs.map((doc) => async () => {
    const ok = await downloadDoc(client, doc);
    if (ok) downloaded++;
    else failed++;
    const total = downloaded + failed;
    if (total % 10 === 0 || total === uniqueDocs.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (downloaded / (elapsed || 1)).toFixed(1);
      process.stdout.write(`\r  ${total}/${uniqueDocs.length} (${downloaded} ok, ${failed} skip) — ${elapsed}s — ${rate} files/s`);
    }
  });

  await parallel(downloadTasks, PARALLEL_DOWNLOADS);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done! ${downloaded} downloaded, ${failed} skipped in ${totalTime}s`);

  await client.disconnect();
}

main().catch(console.error);
