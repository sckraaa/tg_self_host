/**
 * capture_users.mjs — captures full User and UserFull objects from real Telegram.
 *
 * Captures:
 *   1. Self user (users.getUsers + users.getFullUser)
 *   2. All contacts (contacts.getContacts) — each User object in full
 *   3. First N dialog partners — User objects from dialogs
 *   4. users.getFullUser for each unique user found
 *   5. contacts.getStatuses — online status of contacts
 *   6. account.getPrivacy for UserStatusTimestamp
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... TG_SESSION=... node capture_users.mjs
 *
 * Optional:
 *   MAX_FULL_USERS=10   — max users to call getFullUser on (default: 10)
 *   TARGET_USER=<username> — additionally capture a specific user by username
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";
const MAX_FULL_USERS = parseInt(process.env.MAX_FULL_USERS || "10");
const TARGET_USER = process.env.TARGET_USER || "";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH environment variables");
  process.exit(1);
}

const OUTPUT_DIR = resolve(process.cwd(), "output", "user_capture");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ─── TL serializer (same as capture_test_fixtures) ──────────────────
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

/** Extract a compact user summary for the final report */
function summarizeUser(u) {
  return {
    id: u.id?.value ?? u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    phone: u.phone,
    bot: u.bot,
    premium: u.premium,
    verified: u.verified,
    scam: u.scam,
    fake: u.fake,
    deleted: u.deleted,
    contact: u.contact,
    mutualContact: u.mutualContact,
    restricted: u.restricted,
    status: u.status?.className,
    statusWasOnline: u.status?.wasOnline,
    statusExpires: u.status?.expires,
    photo: u.photo?.className ?? null,
    emojiStatus: u.emojiStatus ? ser(u.emojiStatus) : null,
    color: u.color ? ser(u.color) : null,
    profileColor: u.profileColor ? ser(u.profileColor) : null,
    usernames: u.usernames ? ser(u.usernames) : null,
    langCode: u.langCode,
    storiesMaxId: u.storiesMaxId,
    botActiveUsers: u.botActiveUsers,
  };
}

/** Extract compact userFull summary */
function summarizeUserFull(uf) {
  return {
    id: uf.id?.value ?? uf.id,
    about: uf.about,
    birthday: uf.birthday ? ser(uf.birthday) : null,
    blocked: uf.blocked,
    phoneCallsAvailable: uf.phoneCallsAvailable,
    phoneCallsPrivate: uf.phoneCallsPrivate,
    canPinMessage: uf.canPinMessage,
    hasScheduled: uf.hasScheduled,
    videoCallsAvailable: uf.videoCallsAvailable,
    voiceMessagesForbidden: uf.voiceMessagesForbidden,
    translationsDisabled: uf.translationsDisabled,
    storiesPinnedAvailable: uf.storiesPinnedAvailable,
    blockedMyStoriesFrom: uf.blockedMyStoriesFrom,
    wallpaperOverridden: uf.wallpaperOverridden,
    contactRequirePremium: uf.contactRequirePremium,
    readDatesPrivate: uf.readDatesPrivate,
    commonChatsCount: uf.commonChatsCount,
    pinnedMsgId: uf.pinnedMsgId,
    ttlPeriod: uf.ttlPeriod,
    themeEmoticon: uf.themeEmoticon,
    privateForwardName: uf.privateForwardName,
    personalChannelId: uf.personalChannelId,
    personalChannelMessage: uf.personalChannelMessage,
    stargiftsCount: uf.stargiftsCount,
    personalPhoto: uf.personalPhoto ? "present" : null,
    profilePhoto: uf.profilePhoto ? "present" : null,
    fallbackPhoto: uf.fallbackPhoto ? "present" : null,
    wallpaper: uf.wallpaper ? "present" : null,
    businessWorkHours: uf.businessWorkHours ? "present" : null,
    businessLocation: uf.businessLocation ? "present" : null,
    businessGreetingMessage: uf.businessGreetingMessage ? "present" : null,
    businessAwayMessage: uf.businessAwayMessage ? "present" : null,
    businessIntro: uf.businessIntro ? "present" : null,
    botInfo: uf.botInfo ? "present" : null,
    stories: uf.stories ? "present" : null,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUTPUT_DIR);
  console.log(`📁 Output: ${OUTPUT_DIR}\n`);

  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => { throw new Error("Session expired — re-login via capture.mjs"); },
    password: async () => { throw new Error("Session expired"); },
    phoneCode: async () => { throw new Error("Session expired"); },
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("✅ Connected to official Telegram\n");

  const collectedUsers = new Map(); // id -> User object
  const collectedUserFulls = new Map(); // id -> UserFull object
  const errors = [];

  // ═════════════════════════════════════════════════════════════════
  // 1. Self user
  // ═════════════════════════════════════════════════════════════════
  console.log("── 1. Self user ──");

  try {
    const selfUsers = await client.invoke(
      new Api.users.GetUsers({ id: [new Api.InputUserSelf()] })
    );
    if (selfUsers?.length > 0) {
      const selfUser = selfUsers[0];
      const uid = selfUser.id?.value ?? selfUser.id;
      collectedUsers.set(String(uid), selfUser);
      save("users.getUsers__self", { method: "users.getUsers", capturedAt: new Date().toISOString(), response: ser(selfUsers) });
      console.log(`    Self: ${selfUser.firstName} (ID: ${uid})`);
    }
  } catch (err) {
    console.error(`    ❌ users.getUsers: ${err.message}`);
    errors.push({ method: "users.getUsers__self", error: err.message });
  }

  try {
    const selfFull = await client.invoke(
      new Api.users.GetFullUser({ id: new Api.InputUserSelf() })
    );
    if (selfFull?.fullUser) {
      const uid = selfFull.fullUser.id?.value ?? selfFull.fullUser.id;
      collectedUserFulls.set(String(uid), selfFull.fullUser);
      // Also collect users from the response
      for (const u of (selfFull.users || [])) {
        const id = u.id?.value ?? u.id;
        collectedUsers.set(String(id), u);
      }
      save("users.getFullUser__self", { method: "users.getFullUser", capturedAt: new Date().toISOString(), response: ser(selfFull) });
    }
  } catch (err) {
    console.error(`    ❌ users.getFullUser: ${err.message}`);
    errors.push({ method: "users.getFullUser__self", error: err.message });
  }

  await sleep(300);

  // ═════════════════════════════════════════════════════════════════
  // 2. Contacts
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 2. Contacts ──");

  try {
    const contacts = await client.invoke(
      new Api.contacts.GetContacts({ hash: BigInt(0) })
    );
    save("contacts.getContacts", { method: "contacts.getContacts", capturedAt: new Date().toISOString(), response: ser(contacts) });
    const contactUsers = contacts?.users || [];
    console.log(`    Got ${contactUsers.length} contact users`);
    for (const u of contactUsers) {
      const id = u.id?.value ?? u.id;
      collectedUsers.set(String(id), u);
    }
  } catch (err) {
    console.error(`    ❌ contacts.getContacts: ${err.message}`);
    errors.push({ method: "contacts.getContacts", error: err.message });
  }

  await sleep(300);

  // ═════════════════════════════════════════════════════════════════
  // 3. contacts.getStatuses
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 3. Contact statuses ──");

  try {
    const statuses = await client.invoke(new Api.contacts.GetStatuses());
    save("contacts.getStatuses", { method: "contacts.getStatuses", capturedAt: new Date().toISOString(), response: ser(statuses) });
    console.log(`    Got ${(statuses || []).length} contact status entries`);
  } catch (err) {
    console.error(`    ❌ contacts.getStatuses: ${err.message}`);
    errors.push({ method: "contacts.getStatuses", error: err.message });
  }

  await sleep(300);

  // ═════════════════════════════════════════════════════════════════
  // 4. Dialogs — collect user objects from dialog list
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 4. Dialog users ──");

  try {
    const dialogs = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        limit: 50,
        hash: BigInt(0),
      })
    );
    const dialogUsers = dialogs?.users || [];
    console.log(`    Got ${dialogUsers.length} users from dialogs`);
    for (const u of dialogUsers) {
      const id = u.id?.value ?? u.id;
      collectedUsers.set(String(id), u);
    }
    // Don't save full dialogs response (too big), just the users
    save("dialogs__users_only", {
      method: "messages.getDialogs (users extracted)",
      capturedAt: new Date().toISOString(),
      users: ser(dialogUsers),
    });
  } catch (err) {
    console.error(`    ❌ messages.getDialogs: ${err.message}`);
    errors.push({ method: "messages.getDialogs", error: err.message });
  }

  await sleep(300);

  // ═════════════════════════════════════════════════════════════════
  // 5. Optional: resolve a specific user by username
  // ═════════════════════════════════════════════════════════════════
  if (TARGET_USER) {
    console.log(`\n── 5. Resolve TARGET_USER: @${TARGET_USER} ──`);
    try {
      const resolved = await client.invoke(
        new Api.contacts.ResolveUsername({ username: TARGET_USER })
      );
      save(`contacts.resolveUsername__${TARGET_USER}`, {
        method: "contacts.resolveUsername",
        capturedAt: new Date().toISOString(),
        response: ser(resolved),
      });
      for (const u of (resolved?.users || [])) {
        const id = u.id?.value ?? u.id;
        collectedUsers.set(String(id), u);
      }
    } catch (err) {
      console.error(`    ❌ contacts.resolveUsername: ${err.message}`);
      errors.push({ method: `contacts.resolveUsername__${TARGET_USER}`, error: err.message });
    }
    await sleep(300);
  }

  // ═════════════════════════════════════════════════════════════════
  // 6. users.getFullUser for each unique user (up to MAX_FULL_USERS)
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n── 6. Full user profiles (max ${MAX_FULL_USERS}) ──`);
  console.log(`    Total unique users collected: ${collectedUsers.size}`);

  let fullCount = 0;
  for (const [uid, user] of collectedUsers) {
    if (fullCount >= MAX_FULL_USERS) {
      console.log(`    (reached max ${MAX_FULL_USERS}, stopping)`);
      break;
    }
    // Skip if already have fullUser
    if (collectedUserFulls.has(uid)) continue;
    // Need accessHash for InputUser
    const accessHash = user.accessHash?.value ?? user.accessHash;
    if (!accessHash) continue;

    try {
      const result = await client.invoke(
        new Api.users.GetFullUser({
          id: new Api.InputUser({ userId: BigInt(uid), accessHash: BigInt(accessHash) }),
        })
      );
      if (result?.fullUser) {
        collectedUserFulls.set(uid, result.fullUser);
        // Collect any additional user objects
        for (const u of (result.users || [])) {
          const id = u.id?.value ?? u.id;
          collectedUsers.set(String(id), u);
        }
        const name = user.firstName || uid;
        const isBot = user.bot ? " [BOT]" : "";
        save(`users.getFullUser__${uid}`, {
          method: "users.getFullUser",
          userName: `${name}${isBot}`,
          capturedAt: new Date().toISOString(),
          response: ser(result),
        });
        console.log(`    [${++fullCount}] ${name}${isBot} (${uid}) — birthday: ${result.fullUser.birthday ? JSON.stringify(ser(result.fullUser.birthday)) : "none"}`);
      }
    } catch (err) {
      console.error(`    ❌ getFullUser(${uid}): ${err.message}`);
      errors.push({ method: `users.getFullUser__${uid}`, error: err.message });
      fullCount++; // count errors toward limit too
    }
    await sleep(500); // Be gentle on rate limits
  }

  // ═════════════════════════════════════════════════════════════════
  // 7. Privacy settings for status visibility
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 7. Privacy settings ──");

  try {
    const privacy = await client.invoke(
      new Api.account.GetPrivacy({
        key: new Api.InputPrivacyKeyStatusTimestamp(),
      })
    );
    save("account.getPrivacy__statusTimestamp", {
      method: "account.getPrivacy",
      key: "InputPrivacyKeyStatusTimestamp",
      capturedAt: new Date().toISOString(),
      response: ser(privacy),
    });
    console.log(`    Status timestamp privacy: ${(privacy?.rules || []).map(r => r.className).join(", ")}`);
  } catch (err) {
    console.error(`    ❌ account.getPrivacy: ${err.message}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // 8. account.updateBirthday capture (read current birthday)
  // ═════════════════════════════════════════════════════════════════
  console.log("\n── 8. Self birthday info ──");
  const selfId = [...collectedUserFulls.keys()][0];
  if (selfId && collectedUserFulls.get(selfId)?.birthday) {
    console.log(`    Self birthday: ${JSON.stringify(ser(collectedUserFulls.get(selfId).birthday))}`);
  } else {
    console.log("    Self birthday: not set");
  }

  // ═════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("  CAPTURE SUMMARY");
  console.log("═".repeat(70));
  console.log(`  Total unique users: ${collectedUsers.size}`);
  console.log(`  Full profiles captured: ${collectedUserFulls.size}`);
  console.log(`  Errors: ${errors.length}`);

  // Build summary report
  const report = {
    capturedAt: new Date().toISOString(),
    stats: {
      totalUsers: collectedUsers.size,
      totalFullProfiles: collectedUserFulls.size,
      errors: errors.length,
    },
    userSummaries: [],
    userFullSummaries: [],
    allUserFields: new Set(),
    allUserFullFields: new Set(),
    errors,
  };

  // Collect all field names seen across all User objects
  const allUserFields = {};
  const allUserFullFields = {};

  for (const [uid, user] of collectedUsers) {
    report.userSummaries.push(summarizeUser(user));
    for (const key of Object.keys(user)) {
      if (key.startsWith("_") || key === "CONSTRUCTOR_ID" || key === "SUBCLASS_OF_ID" || key === "classType") continue;
      const val = user[key];
      if (!allUserFields[key]) allUserFields[key] = { presentCount: 0, nonNullCount: 0, sampleValues: [] };
      allUserFields[key].presentCount++;
      if (val !== null && val !== undefined && val !== false) {
        allUserFields[key].nonNullCount++;
        if (allUserFields[key].sampleValues.length < 3) {
          try {
            const s = typeof val === "object" ? (val.className || JSON.stringify(ser(val)).slice(0, 80)) : String(val);
            allUserFields[key].sampleValues.push(s);
          } catch {}
        }
      }
    }
  }

  for (const [uid, uf] of collectedUserFulls) {
    report.userFullSummaries.push(summarizeUserFull(uf));
    for (const key of Object.keys(uf)) {
      if (key.startsWith("_") || key === "CONSTRUCTOR_ID" || key === "SUBCLASS_OF_ID" || key === "classType") continue;
      const val = uf[key];
      if (!allUserFullFields[key]) allUserFullFields[key] = { presentCount: 0, nonNullCount: 0, sampleValues: [] };
      allUserFullFields[key].presentCount++;
      if (val !== null && val !== undefined && val !== false) {
        allUserFullFields[key].nonNullCount++;
        if (allUserFullFields[key].sampleValues.length < 3) {
          try {
            const s = typeof val === "object" ? (val.className || JSON.stringify(ser(val)).slice(0, 100)) : String(val);
            allUserFullFields[key].sampleValues.push(s);
          } catch {}
        }
      }
    }
  }

  report.allUserFields = allUserFields;
  report.allUserFullFields = allUserFullFields;

  save("_summary_report", report);

  // Print field analysis
  console.log(`\n  ── User object fields (across ${collectedUsers.size} users) ──`);
  for (const [field, info] of Object.entries(allUserFields).sort((a, b) => b[1].nonNullCount - a[1].nonNullCount)) {
    const pct = ((info.nonNullCount / info.presentCount) * 100).toFixed(0);
    const samples = info.sampleValues.length > 0 ? ` ex: ${info.sampleValues.slice(0, 2).join(", ")}` : "";
    console.log(`    ${field}: ${info.nonNullCount}/${info.presentCount} non-null (${pct}%)${samples}`);
  }

  console.log(`\n  ── UserFull object fields (across ${collectedUserFulls.size} profiles) ──`);
  for (const [field, info] of Object.entries(allUserFullFields).sort((a, b) => b[1].nonNullCount - a[1].nonNullCount)) {
    const pct = ((info.nonNullCount / info.presentCount) * 100).toFixed(0);
    const samples = info.sampleValues.length > 0 ? ` ex: ${info.sampleValues.slice(0, 2).join(", ")}` : "";
    console.log(`    ${field}: ${info.nonNullCount}/${info.presentCount} non-null (${pct}%)${samples}`);
  }

  if (errors.length > 0) {
    console.log(`\n  ── Errors ──`);
    for (const e of errors) {
      console.log(`    ${e.method}: ${e.error}`);
    }
  }

  console.log("\n✅ Done! Check output/user_capture/ for full JSON dumps.\n");

  await client.disconnect();
}

main().catch(console.error);
