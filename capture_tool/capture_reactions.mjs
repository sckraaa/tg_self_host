/**
 * Capture messages.getAvailableReactions from official Telegram servers.
 * Saves both JSON (for inspection) and raw TL bytes (for serving directly).
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_reactions.mjs
 *
 * API_ID and API_HASH should be from Telegram Web A:
 *   API_ID=2496  API_HASH=8da85b0d5bfe62527e5b244c209159c3
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const API_ID = parseInt(process.env.TG_API_ID || "2496");
const API_HASH = process.env.TG_API_HASH || "8da85b0d5bfe62527e5b244c209159c3";
const SESSION_STRING = process.env.TG_SESSION || "";

if (!SESSION_STRING) {
  console.error("Set TG_SESSION environment variable (StringSession from previous login)");
  process.exit(1);
}

const OUTPUT_DIR = resolve(process.cwd(), "..", "self_hosted_version", "data");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function ser(obj, depth = 0) {
  if (depth > 12) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return { __type: "Buffer", hex: obj.toString("hex").slice(0, 2048) };
  if (obj instanceof Uint8Array) return { __type: "Buffer", hex: Buffer.from(obj).toString("hex").slice(0, 2048) };
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

async function main() {
  ensureDir(OUTPUT_DIR);
  console.log(`Output: ${OUTPUT_DIR}\n`);

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
    phoneNumber: async () => { throw new Error("Session expired — re-login needed"); },
    password: async () => { throw new Error("Session expired — re-login needed"); },
    phoneCode: async () => { throw new Error("Session expired — re-login needed"); },
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("✅ Connected to official Telegram\n");

  // ── Capture messages.getAvailableReactions ─────────────────────────
  console.log("📡 Fetching messages.getAvailableReactions...");
  try {
    const response = await client.invoke(
      new Api.messages.GetAvailableReactions({ hash: 0 })
    );

    if (response.className === "messages.AvailableReactionsNotModified") {
      console.log("⚠️  Got AvailableReactionsNotModified — trying with hash=0...");
    }

    // Save raw TL bytes
    const rawBytes = response.getBytes();
    const rawPath = join(OUTPUT_DIR, "available_reactions.bin");
    writeFileSync(rawPath, rawBytes);
    console.log(`✅ Raw TL bytes saved: ${rawPath} (${rawBytes.length} bytes)`);

    // Save JSON for inspection
    const jsonPath = join(OUTPUT_DIR, "available_reactions.json");
    const jsonData = {
      method: "messages.getAvailableReactions",
      capturedAt: new Date().toISOString(),
      className: response.className,
      constructorId: response.CONSTRUCTOR_ID >>> 0,
      rawBytesLength: rawBytes.length,
      response: ser(response),
    };
    writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
    console.log(`✅ JSON saved: ${jsonPath}`);

    // Summary
    if (response.reactions) {
      console.log(`\n📊 ${response.reactions.length} reactions captured:`);
      const emojis = response.reactions.map(r => r.reaction).join(" ");
      console.log(`   ${emojis}`);
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
  }

  await client.disconnect();
  console.log("\n👋 Done!");
}

main().catch(console.error);
