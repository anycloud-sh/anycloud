import { platform } from 'os';
import { execAsync, isCliInstalled, spawnInteractive } from './cli-exec.js';

/**
 * Azure subscription visible to the active Azure CLI account.
 */
export interface AzureSubscription {
  id: string;
  name?: string;
  tenantId?: string;
  isDefault?: boolean;
}

/**
 * Check if Azure CLI is installed
 */
export async function isAzureCLIInstalled(): Promise<boolean> {
  return isCliInstalled('az');
}

/**
 * Check if user is logged in to Azure CLI
 */
export async function isAzureCLILoggedIn(): Promise<boolean> {
  try {
    await execAsync('az account show --output json');
    return true;
  } catch {
    return false;
  }
}

/**
 * Microsoft's Linux packages need root, and its per-user script supports only
 * Python 3.8–3.10, so Linux gets the docs link instead of a command.
 */
export function getAzureCLIInstallCommand(): string {
  const os = platform();
  if (os === 'darwin') return 'brew install azure-cli';
  if (os === 'win32') return 'winget install --exact --id Microsoft.AzureCLI';
  return os === 'linux'
    ? 'https://learn.microsoft.com/cli/azure/install-azure-cli-linux (Linux packages need administrator rights)'
    : 'https://learn.microsoft.com/cli/azure/install-azure-cli';
}

/**
 * Login to Azure CLI (opens browser for interactive login)
 */
export async function loginToAzure(): Promise<void> {
  await spawnInteractive('az', ['login']);
}

/**
 * Get the currently selected Azure CLI subscription.
 */
export async function getCurrentAzureSubscription(): Promise<AzureSubscription | null> {
  try {
    const output = await execAsync('az account show --output json');
    const account = JSON.parse(output);
    if (!account.id) {
      return null;
    }
    return {
      id: account.id,
      name: account.name,
      tenantId: account.tenantId,
      isDefault: account.isDefault,
    };
  } catch {
    return null;
  }
}

/**
 * List Azure subscriptions available to the active Azure CLI account.
 */
export async function listAzureSubscriptions(): Promise<AzureSubscription[]> {
  try {
    const output = await execAsync('az account list --output json');
    const accounts = JSON.parse(output);
    if (!Array.isArray(accounts)) {
      return [];
    }
    return accounts
      .filter((account) => account.id)
      .map((account) => ({
        id: account.id,
        name: account.name,
        tenantId: account.tenantId,
        isDefault: account.isDefault,
      }));
  } catch (error) {
    throw new Error(
      `Failed to list Azure subscriptions: ${(error as Error).message}`,
    );
  }
}
