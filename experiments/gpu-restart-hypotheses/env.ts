/**
 * Imported first: the product's config reads these at import time. Test mode
 * keeps the SSH control sockets off the API's tmpfs, and a throwaway cipher
 * key keeps config from writing one into the runner's ~/.anycloud.
 */
import { randomBytes } from 'node:crypto';

process.env.IS_TEST = 'true';
process.env.CIPHER_KEY ??= randomBytes(32).toString('hex');
