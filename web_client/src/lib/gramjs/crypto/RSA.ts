import {
  generateRandomBytes,
  modExp,
  readBigIntFromBuffer,
  readBufferFromBigInt,
  sha1,
} from '../Helpers';

export const SERVER_KEYS = [
  {
    fingerprint: BigInt('-4164099621493681641'),
    n: BigInt(
      '0xb9c491464de4a766c1e415d3ba806bc564c29b575f74b8edcdcd1674c806e3690318f6bb32b9fd936b19419cf93d280a40c4543763424faf65f2732331b7b2734c29cb374fede4b891c556d23a03634d8b99d9754fae807aca2c0aa49cb6677ecaf5d8d89d9782711b072aed417a7b4cfae204778cc60727e6e1e7db01db013900a780ae9eca4d19f6426cc2104df335a98300c01d4eeb1df57740b195a300c16c907333b00d113cc54f68cc5007dfe7b9747f85d30b09574761bf5d03c0ce4c70f2ddeaf00dffcbc4d8b76d959a3c7d9eeae41fe4f06fd91d51648415b0594b1ae9c8e3a7360a92ad6e23fe9c24a4b70a93dbd62b6ed9a839886be892948bb9'
    ),
    e: 65537,
  },
].reduce((acc, { fingerprint, ...keyInfo }) => {
  acc.set(fingerprint, keyInfo);
  return acc;
}, new Map<bigint, { n: bigint; e: number }>());

/**
 * Encrypts the given data known the fingerprint to be used
 * in the way Telegram requires us to do so (sha1(data) + data + padding)

 * @param fingerprint the fingerprint of the RSA key.
 * @param data the data to be encrypted.
 * @returns {Buffer|*|undefined} the cipher text, or undefined if no key matching this fingerprint is found.
 */
export async function encrypt(fingerprint: bigint, data: Buffer) {
  const key = SERVER_KEYS.get(fingerprint);
  if (!key) {
    return undefined;
  }

  // len(sha1.digest) is always 20, so we're left with 255 - 20 - x padding
  const rand = generateRandomBytes(235 - data.length);

  const toEncrypt = Buffer.concat([await sha1(data), data, rand]);

  // rsa module rsa.encrypt adds 11 bits for padding which we don't want
  // rsa module uses rsa.transform.bytes2int(to_encrypt), easier way:
  const payload = readBigIntFromBuffer(toEncrypt, false);
  const encrypted = modExp(payload, BigInt(key.e), key.n);
  // rsa module uses transform.int2bytes(encrypted, keylength), easier:
  return readBufferFromBigInt(encrypted, 256, false);
}
