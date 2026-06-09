import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;   // 96-bit IV per RFC 5116 §3.2 — optimal for AES-GCM
const TAG_LEN = 16;
const KEY_LEN = 32;

// Fixed salt — security comes from ENCRYPTION_KEY (high-entropy 32-char random key),
// not from the salt. Static salt is correct here; per-operation salt was the wrong pattern
// for a static master key (it forced an expensive KDF call on every encrypt/decrypt).
const STATIC_SALT = Buffer.from('atlassian-teams-bot-kdf-v2-salt!', 'utf8'); // 32 bytes

// Derive once at application startup. scryptSync is intentionally CPU-intensive;
// running it on every encrypt/decrypt blocked the event loop for 50–150 ms under load.
const DERIVED_KEY = scryptSync(config.ENCRYPTION_KEY, STATIC_SALT, KEY_LEN) as Buffer;

// Blob layout: iv(12) | tag(16) | ciphertext
// NOTE: changing IV_LEN or removing the salt invalidates existing sessions.
// Sessions have an 8-hour TTL so this is safe to deploy — in-flight sessions
// will fail to decrypt once and re-authenticate automatically.

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, DERIVED_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, DERIVED_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
