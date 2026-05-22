import { UserCredentials } from '../types';
import { encrypt, decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';

interface StoreEntry {
  ciphertext: string;
  createdAt: number;
}

// In-memory store — replace with Redis for multi-instance HA deployments.
const store = new Map<string, StoreEntry>();

// 8-hour TTL matches a typical workday session
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function storeCredentials(userId: string, creds: UserCredentials): void {
  const plaintext = JSON.stringify(creds);
  const ciphertext = encrypt(plaintext, config.ENCRYPTION_KEY);
  store.set(userId, { ciphertext, createdAt: Date.now() });
}

export function getCredentials(userId: string): UserCredentials | null {
  const entry = store.get(userId);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    store.delete(userId);
    logger.debug(`Session expired for user ${userId}`);
    return null;
  }

  try {
    const plaintext = decrypt(entry.ciphertext, config.ENCRYPTION_KEY);
    return JSON.parse(plaintext) as UserCredentials;
  } catch (err) {
    logger.error('Failed to decrypt credentials — clearing entry', err);
    store.delete(userId);
    return null;
  }
}

export function clearCredentials(userId: string): void {
  store.delete(userId);
}

export function hasCredentials(userId: string): boolean {
  return getCredentials(userId) !== null;
}

// Purge expired entries every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, entry] of store.entries()) {
    if (entry.createdAt < cutoff) store.delete(id);
  }
}, 30 * 60 * 1000).unref();
