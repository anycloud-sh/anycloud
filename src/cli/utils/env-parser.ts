import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseDotenv } from 'dotenv';

/**
 * Parse environment variables from a .env file
 * @param filePath Path to the .env file (relative or absolute)
 * @returns Record of environment variables
 * @throws Error if file doesn't exist or can't be parsed
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const absolutePath = resolve(process.cwd(), filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }

  try {
    const fileContent = readFileSync(absolutePath, 'utf-8');
    const parsed = parseDotenv(Buffer.from(fileContent));

    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, string>;
    }

    return {};
  } catch (error) {
    throw new Error(
      `Failed to parse environment file: ${(error as Error).message}`,
    );
  }
}

/**
 * Parse environment variables from -e flags
 * Supports two formats:
 *   1. KEY=VALUE - explicit value
 *   2. KEY - read from process.env
 * @param envFlags Array of -e flag values
 * @returns Record of environment variables
 * @throws Error if KEY format is used but variable not found in process.env
 */
export function parseEnvFlags(envFlags: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const flag of envFlags) {
    if (flag.includes('=')) {
      // Format: KEY=VALUE
      const separatorIndex = flag.indexOf('=');
      const key = flag.substring(0, separatorIndex);
      const value = flag.substring(separatorIndex + 1);

      if (!key) {
        throw new Error(`Invalid -e flag format: "${flag}" (missing key)`);
      }

      // Collapse newlines to spaces to prevent shell parsing issues
      // when the value is used as a docker -e argument
      result[key] = value.replace(/\n/g, ' ');
    } else {
      // Format: KEY - read from process.env
      const key = flag;

      if (!key) {
        throw new Error('Invalid -e flag: empty key');
      }

      if (!(key in process.env)) {
        throw new Error(
          `Environment variable "${key}" not found in current shell environment.\n` +
            `   Either set it in your shell or use -e ${key}=VALUE format.`,
        );
      }

      result[key] = process.env[key]!.replace(/\n/g, ' ');
    }
  }

  return result;
}
