/**
 * Download all reaction document files (animations, icons) from official Telegram.
 * Stores them in self_hosted_version/data/files/ keyed by document ID.
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_reaction_files.mjs
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

const FILES_DIR = resolve(process.cwd(), "..", "self_hosted_version", "data", "files");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function downloadDoc(client, doc, label) {
  if (!doc || !doc.id) return;
  const docId = doc.id.toString();
  const outPath = join(FILES_DIR, docId);
  if (existsSync(outPath)) {
    console.log(`  ⏭ ${label} id=${docId} already exists`);
    return;
  }
  try {
    const buffer = await client.downloadMedia(doc, {});
    if (buffer && buffer.length > 0) {
      writeFileSync(outPath, buffer);
      console.log(`  ✅ ${label} id=${docId} → ${buffer.length} bytes`);
    } else {
      console.log(`  ⚠️ ${label} id=${docId} → empty response`);
    }
  } catch (e) {
    console.error(`  ❌ ${label} id=${docId} error: ${e.message}`);
  }
}

async function main() {
  ensureDir(FILES_DIR);
  console.log(`Output: ${FILES_DIR}\n`);

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

  console.log("📡 Fetching messages.getAvailableReactions...");
  const response = await client.invoke(
    new Api.messages.GetAvailableReactions({ hash: 0 })
  );

  if (!response.reactions || response.reactions.length === 0) {
    console.error("❌ No reactions returned");
    await client.disconnect();
    return;
  }

  console.log(`📊 ${response.reactions.length} reactions found\n`);

  let total = 0;
  for (const r of response.reactions) {
    console.log(`\n${r.reaction} (${r.title}):`);
    const docs = [
      ["staticIcon", r.staticIcon],
      ["selectAnimation", r.selectAnimation],
      ["activateAnimation", r.activateAnimation],
      ["effectAnimation", r.effectAnimation],
      ["aroundAnimation", r.aroundAnimation],
      ["centerIcon", r.centerIcon],
      ["appearAnimation", r.appearAnimation],
    ];
    for (const [label, doc] of docs) {
      if (doc) {
        await downloadDoc(client, doc, label);
        total++;
      }
    }
  }

  console.log(`\n✅ Done! Downloaded files for ${response.reactions.length} reactions (${total} documents)`);
  await client.disconnect();
}

main().catch(console.error);
