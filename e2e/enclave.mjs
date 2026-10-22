// Enclave simulée pour les modèles E2EE : attestation TDX minimale liant le nonce du client
// et l'adresse de la clé de l'enclave, puis chiffrement ECDH secp256k1 + HKDF + AES-256-GCM.
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from "node:crypto";

const M = (1n << 64n) - 1n;
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x80000001n, 0x8000000080008008n,
];
const rot = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M);

function keccakF(s) {
  for (const rc of RC) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rot(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let [x, y, cur] = [1, 0, s[1]];
    for (let t = 0; t < 24; t++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const next = s[x + 5 * y];
      s[x + 5 * y] = rot(cur, BigInt((((t + 1) * (t + 2)) / 2) % 64));
      cur = next;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & M & row[(x + 2) % 5]);
    }
    s[0] ^= rc;
  }
}

/** Keccak-256 (Ethereum), absent de node:crypto. */
export function keccak256(data) {
  const rate = 136;
  const msg = Buffer.concat([data, Buffer.alloc(rate - (data.length % rate))]);
  msg[data.length] |= 0x01;
  msg[msg.length - 1] |= 0x80;
  const s = Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= msg.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

const aesKey = (ecdh, peer) => Buffer.from(hkdfSync("sha256", ecdh.computeSecret(peer), Buffer.alloc(0), "ecdsa_encryption", 32));

export function encryptFor(peerHex, plain) {
  const eph = createECDH("secp256k1");
  eph.generateKeys();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(eph, Buffer.from(peerHex, "hex")), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return Buffer.concat([eph.getPublicKey(), iv, ct]).toString("hex");
}

/** Clé de l'enclave (une par lancement du faux serveur). */
const enclave = createECDH("secp256k1");
enclave.generateKeys();
export const enclavePubHex = enclave.getPublicKey("hex");

export function decrypt(hex) {
  const raw = Buffer.from(hex, "hex");
  const d = createDecipheriv("aes-256-gcm", aesKey(enclave, raw.subarray(0, 65)), raw.subarray(65, 77));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(77, raw.length - 16)), d.final()]).toString("utf8");
}

/** Attestation : quote TDX (type 0x81, hors debug) dont le REPORTDATA lie adresse et nonce. */
export function attestation(model, nonceHex) {
  const quote = Buffer.alloc(48 + 520 + 64 + 16);
  quote.writeUInt32LE(0x81, 4);
  keccak256(enclave.getPublicKey().subarray(1)).copy(quote, 48 + 520, 12);
  createHash("sha256").update(Buffer.from(nonceHex, "hex")).digest().copy(quote, 48 + 520 + 32);
  return { verified: true, model, nonce: nonceHex, signing_key: enclavePubHex, intel_quote: quote.toString("hex"), tee_provider: "enclave-e2e" };
}
