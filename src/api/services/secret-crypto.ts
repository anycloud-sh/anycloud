import _sodium from 'libsodium-wrappers';

import { errorMessage } from '../../shared/log-diagnostics.js';
import config from '../config.js';

let sodium: typeof _sodium | null = null;

async function ensureSodiumReady(): Promise<typeof _sodium> {
  if (!sodium) {
    try {
      await _sodium.ready;
    } catch (err) {
      throw new Error(`Failed to initialize libsodium: ${err}`);
    }
    sodium = _sodium;
  }
  return sodium;
}

/**
 * Encrypt plaintext with libsodium XSalsa20-Poly1305 (crypto_secretbox_easy).
 * Returns base64(nonce || MAC || ciphertext).
 */
export async function secretboxEncrypt(plaintext: string): Promise<string> {
  const s = await ensureSodiumReady();
  const key = s.from_hex(config.cipherKey);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, key);
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return Buffer.from(combined).toString('base64');
}

/** Decrypt a token produced by secretboxEncrypt. */
export async function secretboxDecrypt(token: string): Promise<string> {
  const s = await ensureSodiumReady();
  const key = s.from_hex(config.cipherKey);
  const combined = new Uint8Array(Buffer.from(token, 'base64'));
  const nonce = combined.slice(0, s.crypto_secretbox_NONCEBYTES);
  const ciphertext = combined.slice(s.crypto_secretbox_NONCEBYTES);
  const plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (!plaintext)
    throw new Error('Decryption failed: invalid ciphertext or key');
  return s.to_string(plaintext);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  return secretboxEncrypt(plaintext);
}

export async function decryptSecret(token: string): Promise<string> {
  try {
    return await secretboxDecrypt(token);
  } catch (err) {
    throw new Error(`Failed to decrypt secret: ${errorMessage(err)}`);
  }
}
