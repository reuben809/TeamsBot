import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const SALT_LEN = 32;
const TAG_LEN = 16;
const KEY_LEN = 32;

// Fixed application salt. ENCRYPTION_KEY is a high-entropy secret (not a
// user-chosen password), so a constant salt is cryptographically acceptable
// here and — crucially — makes the derived key deterministic so it can be
// cached. scryptSync is CPU-heavy (~50-150ms) and runs synchronously on the
// main thread; without caching it would block the event loop on every
// encrypt/decrypt (i.e. every credential store/read).
const STATIC_SALT = Buffer.from(
  'mcp-atlassian-teams-bot-kdf-salt-v1',
  'utf8'
).subarray(0, SALT_LEN);

// Cache derived keys per (masterKey, salt). Bounds at one entry per distinct
// master key in practice; legacy random-salt blobs still decrypt correctly
// (cache miss → derive on demand).
const keyCache = new Map<string, Buffer>();

function deriveKey(password: string, salt: Buffer): Buffer {
  const cacheKey = `${password}:${salt.toString('hex')}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = scryptSync(password, salt, KEY_LEN) as Buffer;
    keyCache.set(cacheKey, key);
  }
  return key;
}

export function encrypt(plaintext: string, masterKey: string): string {
  const salt = STATIC_SALT;
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(masterKey, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string, masterKey: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
