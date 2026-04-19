/**
 * capture_privacy.mjs — captures all privacy settings from real Telegram.
 *
 * Captures:
 *   1. account.getPrivacy for every InputPrivacyKey
 *   2. account.getGlobalPrivacySettings
 *   3. account.setPrivacy round-trip test (optional, read-only by default)
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_privacy.mjs
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH environment variables");
  process.exit(1);
}

const OUTPUT_DIR = resolve(process.cwd(), "output", "privacy_capture");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function ser(obj, depth = 0) {
  if (depth > 14) return "[max depth]";
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

function save(name, data) {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(join(OUTPUT_DIR, `${safeName}.json`), JSON.stringify(data, null, 2));
  console.log(`    💾 Saved: ${safeName}.json`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═════════════════════════════════════════════════════════════════
// All InputPrivacyKey types
// ═════════════════════════════════════════════════════════════════
const PRIVACY_KEYS = [
  { name: "StatusTimestamp",    cls: () => new Api.InputPrivacyKeyStatusTimestamp() },
  { name: "ChatInvite",        cls: () => new Api.InputPrivacyKeyChatInvite() },
  { name: "PhoneCall",         cls: () => new Api.InputPrivacyKeyPhoneCall() },
  { name: "PhoneP2P",          cls: () => new Api.InputPrivacyKeyPhoneP2P() },
  { name: "Forwards",          cls: () => new Api.InputPrivacyKeyForwards() },
  { name: "ProfilePhoto",      cls: () => new Api.InputPrivacyKeyProfilePhoto() },
  { name: "PhoneNumber",       cls: () => new Api.InputPrivacyKeyPhoneNumber() },
  { name: "AddedByPhone",      cls: () => new Api.InputPrivacyKeyAddedByPhone() },
  { name: "VoiceMessages",     cls: () => new Api.InputPrivacyKeyVoiceMessages() },
  { name: "About",             cls: () => new Api.InputPrivacyKeyAbout() },
  { name: "Birthday",          cls: () => new Api.InputPrivacyKeyBirthday() },
  { name: "StarGiftsAutoSave", cls: () => new Api.InputPrivacyKeyStarGiftsAutoSave() },
  { name: "NoPaidMessages",    cls: () => new Api.InputPrivacyKeyNoPaidMessages() },
];

(async () => {
  ensureDir(OUTPUT_DIR);

  const client = new TelegramClient(
    new StringSession(SESSION_STRING),
    API_ID,
    API_HASH,
    { connectionRetries: 5, useWSS: false }
  );
  await client.start({ phoneNumber: async () => "", phoneCode: async () => "", onError: (e) => console.error(e) });
  console.log("✅ Connected to Telegram\n");

  // ═════════════════════════════════════════════════════════════════
  // 1. account.getPrivacy for each key
  // ═════════════════════════════════════════════════════════════════
  console.log("── 1. account.getPrivacy for all keys ──\n");

  const allResults = {};

  for (const pk of PRIVACY_KEYS) {
    try {
      const result = await client.invoke(
        new Api.account.GetPrivacy({ key: pk.cls() })
      );
      const serialized = ser(result);
      save(`getPrivacy__${pk.name}`, {
        method: "account.getPrivacy",
        key: `InputPrivacyKey${pk.name}`,
        capturedAt: new Date().toISOString(),
        response: serialized,
      });

      const ruleNames = (result.rules || []).map(r => r.className).join(", ");
      console.log(`    ✅ ${pk.name}: ${ruleNames || "(empty)"}`);
      allResults[pk.name] = serialized;
      await sleep(300);
    } catch (err) {
      console.error(`    ❌ ${pk.name}: ${err.message}`);
      allResults[pk.name] = { error: err.message };
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // 2. account.getGlobalPrivacySettings
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 2. account.getGlobalPrivacySettings ──\n");

  try {
    const globalPrivacy = await client.invoke(
      new Api.account.GetGlobalPrivacySettings()
    );
    save("getGlobalPrivacySettings", {
      method: "account.getGlobalPrivacySettings",
      capturedAt: new Date().toISOString(),
      response: ser(globalPrivacy),
    });
    console.log(`    ✅ Global privacy settings captured`);
    console.log(`       archiveAndMuteNewNoncontactPeers: ${globalPrivacy.archiveAndMuteNewNoncontactPeers}`);
    console.log(`       keepArchivedUnmuted: ${globalPrivacy.keepArchivedUnmuted}`);
    console.log(`       keepArchivedFolders: ${globalPrivacy.keepArchivedFolders}`);
    console.log(`       hideReadMarks: ${globalPrivacy.hideReadMarks}`);
    console.log(`       newNoncontactPeersRequirePremium: ${globalPrivacy.newNoncontactPeersRequirePremium}`);
  } catch (err) {
    console.error(`    ❌ getGlobalPrivacySettings: ${err.message}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // 3. Summary
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 3. Summary ──\n");
  save("_summary", {
    capturedAt: new Date().toISOString(),
    privacyKeys: allResults,
  });

  console.log("✅ All privacy data captured!\n");
  await client.disconnect();
})();
