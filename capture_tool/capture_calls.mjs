/**
 * capture_calls.mjs
 *
 * Captures everything the real Telegram servers send/return during a phone call lifecycle:
 *   - messages.getDhConfig          → DH parameters for E2E key exchange
 *   - phone.getCallConfig           → STUN/TURN server list + library config
 *   - phone.requestCall             → outgoing call (phoneCallWaiting state)
 *   - UpdatePhoneCall               → every state transition pushed by the server
 *   - phone.receivedCall            → ack from callee side
 *   - phone.acceptCall              → callee accepts (phoneCallAccepted state)
 *   - phone.confirmCall             → caller confirms DH (phoneCallActive state)
 *   - phone.discardCall             → hang up (phoneCallDiscarded state)
 *   - phone.setCallRating           → post-call rating
 *   - phone.sendSignalingData       → WebRTC signaling exchange
 *
 * DH is computed automatically — no manual gA/gB needed.
 *
 * Usage (two-device scenario):
 *   Account A (caller):  node capture_calls.mjs
 *     > call <userId>          — request a call (auto-computes gA + gAHash)
 *     > confirm <callId> <accessHash>  — confirm after callee accepted (uses stored gA/b)
 *     > discard <callId> <accessHash>
 *     > callconfig / dhconfig
 *     > quit
 *
 *   Account B (callee): run the same script, then when UpdatePhoneCall arrives:
 *     > received <callId> <accessHash>
 *     > accept <callId> <accessHash>   — auto-fetches DH config and computes gB
 *     > discard <callId> <accessHash>
 *
 * All responses are saved to output/call_capture/.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import readline from "readline";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

// ═══════════════════════════════════════════════════════════════════════
const API_ID = parseInt(process.env.TG_API_ID || "0");
const API_HASH = process.env.TG_API_HASH || "";
const SESSION_STRING = process.env.TG_SESSION || "";

if (!API_ID || !API_HASH) {
  console.error("Set TG_API_ID and TG_API_HASH environment variables");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const OUTPUT_DIR = resolve("output/call_capture");
mkdirSync(OUTPUT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════
// Deep-serialize a GramJS TL object to plain JSON
// ═══════════════════════════════════════════════════════════════════════
function dumpTlObject(obj, depth = 0, maxDepth = 12) {
  if (depth > maxDepth) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return `BigInt(${obj})`;
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj))
    return `Buffer(${obj.length})[${obj.toString("hex").slice(0, 256)}]`;
  if (obj instanceof Uint8Array)
    return `Uint8Array(${obj.length})[${Buffer.from(obj).toString("hex").slice(0, 256)}]`;
  if (Array.isArray(obj))
    return obj.map((item) => dumpTlObject(item, depth + 1, maxDepth));

  const result = {};
  if (obj.className) result._class = obj.className;
  if (obj.CONSTRUCTOR_ID !== undefined)
    result._cid = "0x" + (obj.CONSTRUCTOR_ID >>> 0).toString(16).padStart(8, "0");

  for (const key of Object.keys(obj)) {
    if (
      key.startsWith("_") ||
      key === "CONSTRUCTOR_ID" ||
      key === "SUBCLASS_OF_ID" ||
      key === "classType"
    )
      continue;
    try {
      result[key] = dumpTlObject(obj[key], depth + 1, maxDepth);
    } catch {
      result[key] = "[error]";
    }
  }
  return result;
}

function save(name, data) {
  const filename = `${name}_${Date.now()}.json`;
  const path = resolve(OUTPUT_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`💾  Saved → ${filename}`);
  return path;
}

function sep(label) {
  console.log("\n" + "═".repeat(80));
  console.log(`  ${label}`);
  console.log("═".repeat(80));
}

// ═══════════════════════════════════════════════════════════════════════
// DH helpers (BigInt-based, same math as real Telegram client)
// ═══════════════════════════════════════════════════════════════════════

// Generate random BigInt of byteLen bytes
function randomBigInt(byteLen) {
  const buf = Buffer.allocUnsafe(byteLen);
  for (let i = 0; i < byteLen; i++) buf[i] = Math.floor(Math.random() * 256);
  // ensure top bit set so it's ~256*8-1 bits
  buf[0] |= 0x80;
  return BigInt("0x" + buf.toString("hex"));
}

// Fast modular exponentiation
function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp >> 1n;
    base = (base * base) % mod;
  }
  return result;
}

// Pad BigInt to byteLen bytes (big-endian Buffer)
function bigIntToBuffer(n, byteLen) {
  const hex = n.toString(16).padStart(byteLen * 2, "0");
  return Buffer.from(hex, "hex");
}

// In-memory storage of per-call DH secrets (keyed by callId string)
const dhSecrets = {};

async function fetchDhConfig(client) {
  const res = await client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
  if (!res || res.className === "messages.DhConfigNotModified") {
    throw new Error("getDhConfig returned DhConfigNotModified — no cached config available");
  }
  const g = BigInt(res.g);
  const p = BigInt("0x" + Buffer.from(res.p).toString("hex"));
  return { g, p };
}

// ═══════════════════════════════════════════════════════════════════════
async function main() {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Phone number: "),
    password: async () => await ask("2FA password (or enter): "),
    phoneCode: async () => await ask("Code from Telegram: "),
    onError: (err) => console.error("Auth error:", err),
  });

  console.log("\n✅  Logged in!");
  console.log("Session string:", client.session.save());

  const me = await client.getMe();
  console.log(`\n👤  ${me.firstName} (ID: ${me.id})`);

  // Pre-load entity cache
  console.log("📂  Loading dialogs...");
  await client.getDialogs({ limit: 100 });

  // ─── RAW update listener — captures every UpdatePhoneCall variant ───
  client.addEventHandler((update) => {
    const ts = new Date().toISOString();
    const cn = update?.className || "unknown";

    if (cn === "UpdatePhoneCall") {
      const call = update.phoneCall;
      const state = call?.className || "unknown";
      sep(`[${ts}] UpdatePhoneCall  state=${state}`);
      const dumped = dumpTlObject(update);
      console.log(JSON.stringify(dumped, null, 2));
      console.log("═".repeat(80));
      save(`UpdatePhoneCall__${state}`, dumped);

      // ── Print copy-paste commands ─────────────────────────────────────
      const callId = call.id?.value?.toString?.() ?? call.id?.toString?.();
      const accessHash = call.accessHash?.value?.toString?.() ?? call.accessHash?.toString?.();
      if (callId && accessHash) {
        console.log("\n" + "▶".repeat(80));
        if (state === "PhoneCallRequested") {
          console.log("  📋  КОМАНДЫ ДЛЯ АККАУНТА-Б (callee):");
          console.log(`\n  received ${callId} ${accessHash}`);
          console.log(`  accept   ${callId} ${accessHash}\n`);
        } else if (state === "PhoneCallWaiting") {
          console.log(`  ℹ️  Звонок ожидает ответа. callId=${callId}`);
        } else if (state === "PhoneCallAccepted") {
          console.log(`  ℹ️  Callee принял. Auto-confirm запущен...`);
        } else if (state === "PhoneCallActive") {
          console.log("  ✅  ЗВОНОК АКТИВЕН!");
          console.log(`\n  discard ${callId} ${accessHash}\n`);
        } else if (state === "PhoneCallDiscarded") {
          console.log("  📴  Звонок завершён.");
        }
        console.log("▶".repeat(80) + "\n");
      }

      // ── AUTO-CONFIRM: when caller receives PhoneCallAccepted ──────────
      // The server waits only ~15s for confirmCall — do it immediately.
      if (state === "PhoneCallAccepted" && call.gB) {
        const callIdStr = call.id?.value?.toString?.() ?? call.id?.toString?.();
        const secret = dhSecrets[callIdStr];
        if (secret) {
          console.log(`\n⚡  AUTO-CONFIRMING callId=${callIdStr}...`);
          const { a, gABuf, p } = secret;
          const gBBigInt = BigInt("0x" + Buffer.from(call.gB).toString("hex"));
          const keyVal = modPow(gBBigInt, a, p);
          const keyBuf = bigIntToBuffer(keyVal, 256);
          const keyFingerprint = keyBuf.readBigInt64BE(keyBuf.length - 8);
          const accessHash = call.accessHash?.value ?? call.accessHash;

          client.invoke(new Api.phone.ConfirmCall({
            peer: new Api.InputPhoneCall({ id: call.id.value ?? call.id, accessHash }),
            gA: gABuf,
            keyFingerprint,
            protocol: new Api.PhoneCallProtocol({
              udpP2p: true,
              udpReflector: true,
              minLayer: 65,
              maxLayer: 92,
              libraryVersions: ["5.0.0"],
            }),
          })).then((res) => {
            const d = dumpTlObject(res);
            sep(`phone.confirmCall RESPONSE (auto)`);
            console.log(JSON.stringify(d, null, 2));
            save("phone.confirmCall", d);
          }).catch((err) => {
            console.error(`Auto-confirm error: ${err.message}`);
          });
        } else {
          console.log(`\n⚠️  PhoneCallAccepted received but no DH secret for callId=${callIdStr}`);
          console.log(`    Manual: confirm ${callIdStr} <accessHash> ${Buffer.from(call.gB).toString("hex")}`);
        }
      }
      return;
    }

    // Also catch signaling data updates
    if (cn === "UpdatePhoneCallSignalingData") {
      sep(`[${ts}] UpdatePhoneCallSignalingData`);
      const dumped = dumpTlObject(update);
      console.log(JSON.stringify(dumped, null, 2));
      console.log("═".repeat(80));
      save("UpdatePhoneCallSignalingData", dumped);
      return;
    }
  }, new Raw({}));

  // ─── Command loop ────────────────────────────────────────────────────
  console.log(`
📡  Call Capture — Commands:
  dhconfig                             — messages.getDhConfig
  callconfig                           — phone.getCallConfig
  call <userId> [video]                — phone.requestCall (auto-computes real gA+gAHash)
  received <callId> <accessHash>       — phone.receivedCall (callee side)
  accept <callId> <accessHash>         — phone.acceptCall  (auto-computes real gB via DH)
  confirm <callId> <accessHash> <gB_hex>  — phone.confirmCall (caller; gB_hex from UpdatePhoneCall{Accepted})
  discard <callId> <accessHash> [busy] — phone.discardCall
  rating <callId> <accessHash> <1-5> [comment] — phone.setCallRating
  signal <callId> <accessHash> <hexData> — phone.sendSignalingData
  quit

  📌 gB_hex for confirm: from UpdatePhoneCall{PhoneCallAccepted}.phoneCall.gB Buffer field (printed above)
`);

  while (true) {
    const cmd = (await ask("\n> ")).trim();
    if (!cmd) continue;
    if (cmd === "quit" || cmd === "exit") break;

    // ── dhconfig ────────────────────────────────────────────────────────
    if (cmd === "dhconfig") {
      try {
        sep("messages.getDhConfig");
        const res = await client.invoke(
          new Api.messages.GetDhConfig({ version: 0, randomLength: 0 })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("messages.getDhConfig", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── callconfig ──────────────────────────────────────────────────────
    if (cmd === "callconfig") {
      try {
        sep("phone.getCallConfig");
        const res = await client.invoke(new Api.phone.GetCallConfig());
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.getCallConfig", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── call <userId> [video] ───────────────────────────────────────────
    if (cmd.startsWith("call ")) {
      const parts = cmd.split(/\s+/);
      const userId = parts[1];
      const isVideo = parts[2] === "video";
      if (!userId) { console.log("Usage: call <userId> [video]"); continue; }
      try {
        sep(`phone.requestCall → user ${userId}${isVideo ? " (video)" : ""}`);
        const entity = await client.getInputEntity(BigInt(userId));

        // Real DH: fetch config, generate a, compute gA = g^a mod p
        const { g, p } = await fetchDhConfig(client);
        const a = randomBigInt(256);
        const gA = modPow(g, a, p);
        const gABuf = bigIntToBuffer(gA, 256);
        const gAHash = createHash("sha256").update(gABuf).digest();

        const randomId = Math.floor(Math.random() * 2 ** 31);

        const res = await client.invoke(
          new Api.phone.RequestCall({
            userId: entity,
            randomId,
            gAHash,
            protocol: new Api.PhoneCallProtocol({
              udpP2p: true,
              udpReflector: true,
              minLayer: 65,
              maxLayer: 92,
              libraryVersions: ["5.0.0"],
            }),
            ...(isVideo && { video: true }),
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.requestCall", dumped);

        // Store DH secret for later confirm step
        const callIdStr = res?.phoneCall?.id?.value?.toString?.() ?? res?.phoneCall?.id?.toString?.();
        if (callIdStr) {
          dhSecrets[callIdStr] = { a, gA, gABuf, p, g };
          console.log(`\n🔑  DH secret stored for callId=${callIdStr}`);
          console.log(`    When callee accepts, run: confirm ${callIdStr} <accessHash>`);
        }
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── received <callId> <accessHash> ────────────────────────────────
    if (cmd.startsWith("received ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      try {
        sep(`phone.receivedCall id=${callId}`);
        const res = await client.invoke(
          new Api.phone.ReceivedCall({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.receivedCall", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── accept <callId> <accessHash> ──────────────────────────────────
    // gB is computed automatically via getDhConfig
    if (cmd.startsWith("accept ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      try {
        sep(`phone.acceptCall id=${callId} (computing DH gB...)`);

        // Fetch DH params and compute gB = g^b mod p
        const { g, p } = await fetchDhConfig(client);
        const b = randomBigInt(256);
        const gB = modPow(g, b, p);
        const gBBuf = bigIntToBuffer(gB, 256);

        console.log(`   g  = ${g}`);
        console.log(`   gB = ${gBBuf.toString("hex").slice(0, 64)}...`);

        const res = await client.invoke(
          new Api.phone.AcceptCall({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
            gB: gBBuf,
            protocol: new Api.PhoneCallProtocol({
              udpP2p: true,
              udpReflector: true,
              minLayer: 65,
              maxLayer: 92,
              libraryVersions: ["5.0.0"],
            }),
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.acceptCall", dumped);

        // Store b so we can compute shared key when caller confirms
        const callIdStr = callId.toString();
        dhSecrets[callIdStr] = { b, gBBuf, p, g };
        console.log(`\n🔑  DH b stored for callId=${callIdStr}`);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── confirm <callId> <accessHash> ─────────────────────────────────
    // Caller side: server sends PhoneCallAccepted with gB inside UpdatePhoneCall
    // Pass gB_hex from that update (phoneCall.gB field)
    if (cmd.startsWith("confirm ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      const gBhex = parts[3]; // from UpdatePhoneCall{PhoneCallAccepted}.phoneCall.gB
      if (!gBhex) {
        console.log("Usage: confirm <callId> <accessHash> <gB_hex_from_UpdatePhoneCall>");
        console.log("  gB_hex comes from UpdatePhoneCall{PhoneCallAccepted}.phoneCall.gB Buffer field");
        continue;
      }
      const callIdStr = callId.toString();
      const secret = dhSecrets[callIdStr];
      if (!secret) {
        console.log(`No DH secret found for callId=${callIdStr}. Did you use 'call' from this session?`);
        continue;
      }
      try {
        sep(`phone.confirmCall id=${callId}`);
        const { a, gABuf, p } = secret;
        const gB = BigInt("0x" + gBhex);

        // Shared key = gB^a mod p
        const key = modPow(gB, a, p);
        const keyBuf = bigIntToBuffer(key, 256);
        const keyFingerprint = keyBuf.readBigInt64BE(keyBuf.length - 8);

        console.log(`   key fingerprint = ${keyFingerprint}`);

        const res = await client.invoke(
          new Api.phone.ConfirmCall({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
            gA: gABuf,
            keyFingerprint,
            protocol: new Api.PhoneCallProtocol({
              udpP2p: true,
              udpReflector: true,
              minLayer: 65,
              maxLayer: 92,
              libraryVersions: ["5.0.0"],
            }),
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.confirmCall", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── discard <callId> <accessHash> [busy] ──────────────────────────
    if (cmd.startsWith("discard ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      const isBusy = parts[3] === "busy";
      try {
        sep(`phone.discardCall id=${callId}`);
        const res = await client.invoke(
          new Api.phone.DiscardCall({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
            duration: 0,
            reason: isBusy
              ? new Api.PhoneCallDiscardReasonBusy()
              : new Api.PhoneCallDiscardReasonHangup(),
            connectionId: BigInt(0),
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.discardCall", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── rating <callId> <accessHash> <1-5> [comment] ──────────────────
    if (cmd.startsWith("rating ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      const rating = parseInt(parts[3] || "5");
      const comment = parts.slice(4).join(" ") || "";
      try {
        sep(`phone.setCallRating id=${callId} rating=${rating}`);
        const res = await client.invoke(
          new Api.phone.SetCallRating({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
            rating,
            comment,
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.setCallRating", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    // ── signal <callId> <accessHash> <hexData> ────────────────────────
    if (cmd.startsWith("signal ")) {
      const parts = cmd.split(/\s+/);
      const callId = BigInt(parts[1]);
      const accessHash = BigInt(parts[2]);
      const data = Buffer.from(parts[3] || "00", "hex");
      try {
        sep(`phone.sendSignalingData id=${callId}`);
        const res = await client.invoke(
          new Api.phone.SendSignalingData({
            peer: new Api.InputPhoneCall({ id: callId, accessHash }),
            data,
          })
        );
        const dumped = dumpTlObject(res);
        console.log(JSON.stringify(dumped, null, 2));
        save("phone.sendSignalingData", dumped);
      } catch (err) {
        console.error("Error:", err.message);
      }
      continue;
    }

    console.log("Unknown command. Type 'quit' to exit.");
  }

  rl.close();
  await client.disconnect();
}

main().catch(console.error);
