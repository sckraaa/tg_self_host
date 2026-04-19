#!/usr/bin/env node
/**
 * Generate a unique RSA-2048 key pair for the MTProto server.
 * Updates:
 *   - self_hosted_version/rsa_private.pem (private key)
 *   - self_hosted_version/src/mtproto/auth.ts (N, fingerprint constants)
 *   - web_client/src/lib/gramjs/crypto/RSA.ts (SERVER_KEYS fingerprint + N)
 *
 * Usage: node scripts/generate-rsa-keys.cjs
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SELF_HOSTED = path.resolve(__dirname, '..');
const WEB_CLIENT = path.resolve(__dirname, '..', '..', 'web_client');

console.log('Generating RSA-2048 key pair...');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 65537,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Extract N (modulus) from the public key
const pubKeyObj = crypto.createPublicKey(publicKey);
const pubKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' });

// Parse the DER to extract the modulus (skip ASN.1 headers)
// For RSA-2048 SPKI: the modulus starts at a known offset
const keyJwk = pubKeyObj.export({ format: 'jwk' });
const nBuf = Buffer.from(keyJwk.n, 'base64url');
const nHex = nBuf.toString('hex');
const nBigInt = '0x' + nHex;

// Compute fingerprint: lower 64 bits of SHA1 of the bare RSA public key (TL serialization)
// Telegram fingerprint = SHA1(serialized_rsa_public_key)[12:20] read as little-endian int64
function computeFingerprint(nBuffer, e) {
  // TL serialization of rsa_public_key: constructor(4) + n(TL bytes) + e(TL bytes)
  const nTlBytes = tlBytesEncode(nBuffer);
  const eBuf = Buffer.alloc(4);
  eBuf.writeUInt32BE(e, 0);
  // e as minimal bytes
  let eBytes = eBuf;
  while (eBytes.length > 1 && eBytes[0] === 0) eBytes = eBytes.slice(1);
  const eTlBytes = tlBytesEncode(eBytes);

  const serialized = Buffer.concat([nTlBytes, eTlBytes]);
  const hash = crypto.createHash('sha1').update(serialized).digest();
  return hash.readBigInt64LE(12);
}

function tlBytesEncode(data) {
  const len = data.length;
  let header;
  if (len <= 253) {
    header = Buffer.alloc(1);
    header[0] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 254;
    header[1] = len & 0xff;
    header[2] = (len >> 8) & 0xff;
    header[3] = (len >> 16) & 0xff;
  }
  const totalLen = header.length + len;
  const paddingLen = totalLen % 4 === 0 ? 0 : 4 - (totalLen % 4);
  return Buffer.concat([header, data, Buffer.alloc(paddingLen)]);
}

const fingerprint = computeFingerprint(nBuf, 65537);
console.log(`Modulus (hex): ${nHex.substring(0, 32)}...`);
console.log(`Fingerprint: ${fingerprint.toString()}`);

// 1. Write private key
const pemPath = path.join(SELF_HOSTED, 'rsa_private.pem');
fs.writeFileSync(pemPath, privateKey);
console.log(`Wrote ${pemPath}`);

// 2. Update auth.ts
const authPath = path.join(SELF_HOSTED, 'src', 'mtproto', 'auth.ts');
let authContent = fs.readFileSync(authPath, 'utf-8');

// Replace RSA_PUBLIC_KEY_N
authContent = authContent.replace(
  /const RSA_PUBLIC_KEY_N = BigInt\('[^']+'\);/,
  `const RSA_PUBLIC_KEY_N = BigInt('${nBigInt}');`
);

// Replace RSA_FINGERPRINT
authContent = authContent.replace(
  /const RSA_FINGERPRINT = BigInt\('[^']+'\);/,
  `const RSA_FINGERPRINT = BigInt('${fingerprint.toString()}');`
);

fs.writeFileSync(authPath, authContent);
console.log(`Updated ${authPath}`);

// 3. Update web_client RSA.ts
const rsaClientPath = path.join(WEB_CLIENT, 'src', 'lib', 'gramjs', 'crypto', 'RSA.ts');
if (fs.existsSync(rsaClientPath)) {
  let rsaContent = fs.readFileSync(rsaClientPath, 'utf-8');

  // Replace fingerprint
  rsaContent = rsaContent.replace(
    /fingerprint: BigInt\('[^']+'\)/,
    `fingerprint: BigInt('${fingerprint.toString()}')`
  );

  // Replace n
  rsaContent = rsaContent.replace(
    /n: BigInt\(\s*'0x[0-9a-f]+'\s*\)/s,
    `n: BigInt(\n      '${nBigInt}'\n    )`
  );

  fs.writeFileSync(rsaClientPath, rsaContent);
  console.log(`Updated ${rsaClientPath}`);
} else {
  console.warn(`WARNING: ${rsaClientPath} not found, update manually`);
}

// 4. Update Telegram-iOS RSA keys
const IOS_CLIENT = path.resolve(__dirname, '..', '..', 'Telegram-iOS');

// Generate PKCS#1 PEM format (BEGIN RSA PUBLIC KEY) for iOS
const pubKeyPkcs1 = pubKeyObj.export({ type: 'pkcs1', format: 'pem' });
// Extract just the base64 lines (without header/footer)
const pemLines = pubKeyPkcs1.trim().split('\n');
const pemBody = pemLines.slice(1, -1); // remove header and footer lines

// Format key for Objective-C string literal
function formatObjcKey(pemBodyLines) {
  const header = '-----BEGIN RSA PUBLIC KEY-----';
  const footer = '-----END RSA PUBLIC KEY-----';
  let objcStr = `@"${header}\\n"\n`;
  for (const line of pemBodyLines) {
    objcStr += `             "${line}\\n"\n`;
  }
  objcStr += `             "${footer}"`;
  return objcStr;
}

// 4a. Update MTDatacenterAuthMessageService.m
const authMsgServicePath = path.join(IOS_CLIENT, 'submodules', 'MtProtoKit', 'Sources', 'MTDatacenterAuthMessageService.m');
if (fs.existsSync(authMsgServicePath)) {
  let content = fs.readFileSync(authMsgServicePath, 'utf-8');

  // Replace the self-hosted key string (appears as NSString *selfHostedKey = @"-----BEGIN RSA PUBLIC KEY-----\n" ...)
  content = content.replace(
    /NSString \*selfHostedKey = @"-----BEGIN RSA PUBLIC KEY-----\\n"\n([ \t]*"[A-Za-z0-9+\/=]+\\n"\n)+([ \t]*"-----END RSA PUBLIC KEY-----")/,
    `NSString *selfHostedKey = @"-----BEGIN RSA PUBLIC KEY-----\\n"\n` +
    pemBody.map(line => `             "${line}\\n"`).join('\n') + '\n' +
    `             "-----END RSA PUBLIC KEY-----"`
  );

  fs.writeFileSync(authMsgServicePath, content);
  console.log(`Updated ${authMsgServicePath}`);
} else {
  console.warn(`WARNING: ${authMsgServicePath} not found`);
}

// 4b. Update MTEncryption.m
const encryptionPath = path.join(IOS_CLIENT, 'submodules', 'MtProtoKit', 'Sources', 'MTEncryption.m');
if (fs.existsSync(encryptionPath)) {
  let content = fs.readFileSync(encryptionPath, 'utf-8');

  // Replace the self-hosted key between the comment and the semicolon
  content = content.replace(
    /\/\/ Self-hosted server RSA public key\n[ \t]*NSString \*keyString = @"-----BEGIN RSA PUBLIC KEY-----\\n"\n("[A-Za-z0-9+\/=\\n]+"\n)+"-----END RSA PUBLIC KEY-----";/,
    `// Self-hosted server RSA public key\n    NSString *keyString = @"-----BEGIN RSA PUBLIC KEY-----\\n"\n` +
    pemBody.map(line => `"${line}\\n"`).join('\n') + '\n' +
    `"-----END RSA PUBLIC KEY-----";`
  );

  fs.writeFileSync(encryptionPath, content);
  console.log(`Updated ${encryptionPath}`);
} else {
  console.warn(`WARNING: ${encryptionPath} not found`);
}

console.log('\nDone! Rebuild server and clients after this change.');
console.log('  cd self_hosted_version && npm run build');
console.log('  cd web_client && npm run dev');
console.log('  cd Telegram-iOS && bazel build //Telegram:Telegram');
console.log('  cd Telegram-Android && ./gradlew assembleDebug -Pselfhosted_host=...');

// 5. Update Telegram-Android RSA key (Handshake.cpp)
const ANDROID_CLIENT = path.resolve(__dirname, '..', '..', 'Telegram-Android');
const handshakePath = path.join(ANDROID_CLIENT, 'TMessagesProj', 'jni', 'tgnet', 'Handshake.cpp');
if (fs.existsSync(handshakePath)) {
  let content = fs.readFileSync(handshakePath, 'utf-8');

  // Format PEM body lines for C++ string literal
  const cppKeyStr = pemBody.map(line => `                                              "${line}\\n"`).join('\n');

  // Replace the self-hosted RSA key block
  const selfHostedKeyRegex = /(\/\/ Self-hosted server RSA public key\n\s*serverPublicKeys\.emplace_back\("-----BEGIN RSA PUBLIC KEY-----\\n"\n)([\s\S]*?)("-----END RSA PUBLIC KEY-----"\);)/;
  if (selfHostedKeyRegex.test(content)) {
    content = content.replace(selfHostedKeyRegex,
      `$1${cppKeyStr}\n                                              $3`
    );
  }

  // Replace fingerprint
  const fpHex = (fingerprint < 0n ? (fingerprint + (1n << 64n)).toString(16) : fingerprint.toString(16));
  content = content.replace(
    /(\/\/ Self-hosted server RSA public key[\s\S]*?serverPublicKeysFingerprints\.push_back\()0x[0-9a-f]+(\);)/,
    `$10x${fpHex}$2`
  );

  fs.writeFileSync(handshakePath, content);
  console.log(`Updated ${handshakePath}`);
} else {
  console.warn(`WARNING: ${handshakePath} not found`);
}
