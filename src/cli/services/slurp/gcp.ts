import { mkdir, readdir, stat, writeFile, access, chmod } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { constants } from 'fs';
import { getAnycloudDir } from '../../../shared/utils.js';
import { isCliInstalled } from './cli-exec.js';
import {
  readServiceAccountKey,
  resolveServiceAccountKeyPath,
  type GCPServiceAccountKey,
} from '../credential-onboarding/gcp-key-files.js';

export function isGCloudInstalled(): Promise<boolean> {
  return isCliInstalled('gcloud');
}

/** Google's per-user installer; Windows uses its downloadable installer. */
export function getGCloudInstallCommand(): string {
  return process.platform === 'win32'
    ? 'https://cloud.google.com/sdk/docs/install'
    : 'curl https://sdk.cloud.google.com | bash';
}

/**
 * Get gcloud config directory
 */
export function getGCloudDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return join(appData, 'gcloud');
    }
  }
  return join(homedir(), '.config', 'gcloud');
}

/**
 * Get Application Default Credentials path
 */
export function getADCPath(): string {
  // Check environment variable first
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return resolveServiceAccountKeyPath(
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );
  }

  // Default ADC path
  return join(getGCloudDir(), 'application_default_credentials.json');
}

/**
 * Get all available GCP service account key file paths
 * Checks both standard ADC location and ~/.anycloud directory
 * Returns paths sorted by modification time (most recent first)
 */
export async function getAllServiceAccountKeyPaths(): Promise<string[]> {
  const paths: Array<{ path: string; mtime: Date }> = [];
  const seen = new Set<string>();

  const addPath = async (candidate: string): Promise<void> => {
    const path = resolveServiceAccountKeyPath(candidate);
    if (seen.has(path)) return;
    seen.add(path);

    try {
      const stats = await stat(path);
      paths.push({ path, mtime: stats.mtime });
    } catch {
      // Candidate doesn't exist or cannot be inspected.
    }
  };

  // Check standard ADC location
  await addPath(getADCPath());

  // Check anycloud directory for generated keys
  try {
    const files = await readdir(getAnycloudDir());

    const keyFiles = files.filter(
      (f) => f.endsWith('-key.json') && f.startsWith('anycloud-'),
    );

    for (const file of keyFiles) {
      await addPath(join(getAnycloudDir(), file));
    }
  } catch {
    // .anycloud directory doesn't exist
  }

  // Sort by modification time, most recent first
  paths.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return paths.map((p) => p.path);
}

/**
 * Validate that a file is a valid GCP service account key
 * @param filePath - Path to the key file (supports ~ expansion)
 * @returns Parsed service account key
 */
export async function validateServiceAccountKeyFile(
  filePath: string,
): Promise<GCPServiceAccountKey> {
  const absolutePath = resolveServiceAccountKeyPath(filePath);

  // Check if file exists and is readable
  try {
    await access(absolutePath, constants.R_OK);
  } catch {
    throw new Error(
      `Cannot read file: ${filePath}\nPlease check the path and file permissions.`,
    );
  }

  // Read and parse the key file
  try {
    const key = await readServiceAccountKey(absolutePath);
    return key;
  } catch (error) {
    throw new Error(
      `Invalid service account key file: ${(error as Error).message}`,
    );
  }
}

export interface PreparedGCPServiceAccountKeyImport {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  keyFilePath: string;
  persist: () => Promise<void>;
}

/** Read and validate a key without persisting it before import approval. */
export async function prepareGCPServiceAccountKeyImport(
  keyFilePath: string,
  name?: string,
): Promise<PreparedGCPServiceAccountKeyImport> {
  const key = await validateServiceAccountKeyFile(keyFilePath);
  // Capture the reviewed contents so later changes to the source cannot alter
  // either the stored credential or its local key copy.
  const contents = JSON.stringify(key, null, 2);

  // Determine destination filename
  const originalFilename = basename(keyFilePath);
  let destFilename: string;

  if (name) {
    // Use provided name with standard format
    destFilename = `anycloud-${name}-key.json`;
  } else if (originalFilename.startsWith('anycloud-')) {
    // Already has anycloud prefix, use as-is
    destFilename = originalFilename;
  } else {
    // Add anycloud prefix to original filename
    destFilename = `anycloud-${originalFilename}`;
  }

  const destinationDirectory = getAnycloudDir();
  const destPath = join(destinationDirectory, destFilename);

  return {
    projectId: key.project_id,
    clientEmail: key.client_email,
    privateKey: key.private_key,
    keyFilePath: destPath,
    persist: async () => {
      await mkdir(destinationDirectory, { recursive: true });
      await writeFile(destPath, contents, { mode: 0o600 });
      await chmod(destPath, 0o600);
    },
  };
}
