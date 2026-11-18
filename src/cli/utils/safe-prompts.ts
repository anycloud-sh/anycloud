import prompts from 'prompts';
import { exitWithError } from './output.js';

/**
 * Check if interactive prompts should be allowed.
 *
 * Prompts are only allowed when:
 * - Not in CI mode (CI env var is not 'true')
 * - stdin is a TTY (terminal)
 *
 * @returns true if prompts are allowed, false otherwise
 */
export function shouldAllowPrompts(): boolean {
  // CI=true means non-interactive mode (explicitly)
  if (process.env.CI === 'true') {
    return false;
  }

  // CI=1 or any other truthy value also means non-interactive
  if (process.env.CI && process.env.CI !== 'false') {
    return false;
  }

  // stdin must be a TTY for interactive prompts
  if (!process.stdin.isTTY) {
    return false;
  }

  return true;
}

/**
 * Safe wrapper around prompts that prevents hanging in CI/non-interactive environments.
 *
 * In CI mode or when stdin is not a TTY, prompts will hang waiting for input that never comes.
 * This wrapper detects these conditions and fails fast with a clear error message.
 *
 * @param questions - Prompt object(s) to display
 * @param options - Optional prompts configuration
 * @returns Promise resolving to user answers
 * @throws Exits process if called in non-interactive mode
 */
export async function safePrompts<T extends string = string>(
  questions: prompts.PromptObject<T> | Array<prompts.PromptObject<T>>,
  options?: prompts.Options,
): Promise<prompts.Answers<T>> {
  if (!shouldAllowPrompts()) {
    exitWithError(
      'Interactive prompts are not available in non-interactive mode.\n' +
        '   Please provide all required options via command-line flags or environment variables.',
    );
  }

  return prompts(questions, options);
}

/**
 * Resolve a required value from either a provided string (flag/arg) or an
 * interactive prompt. In non-TTY/CI mode with no provided value, exit with
 * `missingError` instead of hanging. The same `parse` callback validates
 * both flag-provided and prompt-provided input so the two paths can't drift.
 */
export async function requireOrPrompt<T>(
  provided: string | undefined,
  opts: {
    parse: (raw: string) => T;
    missingError: string;
    prompt: prompts.PromptObject<'value'>;
  },
): Promise<T> {
  if (provided !== undefined) return opts.parse(provided);
  if (!shouldAllowPrompts()) {
    exitWithError(opts.missingError);
  }
  const r = await safePrompts<'value'>(opts.prompt);
  if (r.value === undefined) {
    // User aborted (Ctrl-C). Exit cleanly to mirror other commands' behavior.
    process.exit(0);
  }
  return opts.parse(String(r.value));
}
