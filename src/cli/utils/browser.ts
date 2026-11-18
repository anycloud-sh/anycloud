import open from 'open';
import { printInfo } from './output.js';

/**
 * Check whether launching a browser is plausible on this host.
 *
 * macOS and Windows always have a default handler. On Linux there is only a
 * browser to launch when a display server is present, which is not the case on
 * the headless servers that commonly host the Anycloud API.
 *
 * @returns true if a browser launch is worth attempting, false otherwise
 */
function canOpenBrowser(): boolean {
  return (
    process.platform === 'darwin' ||
    process.platform === 'win32' ||
    Boolean(process.env.DISPLAY) ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}

/**
 * Open `url` in the default browser, printing a fallback message instead of
 * failing when that is not possible.
 *
 * `open()` resolves as soon as the child process is spawned and reports a
 * failed spawn through an `error` event on that process, so the listener below
 * is load-bearing: an unhandled `error` event terminates the CLI. A rejected
 * promise is a separate path — Windows resolves the PowerShell binary before
 * spawning and can fail there — so both are handled.
 *
 * @param url - URL to open
 * @param messages - `unavailable` when no browser can be launched at all,
 *   `failed` when the launch was attempted and did not work
 */
export async function openInBrowser(
  url: string,
  messages: { unavailable: string; failed: string },
): Promise<void> {
  if (!canOpenBrowser()) {
    printInfo(messages.unavailable);
    return;
  }

  try {
    const subprocess = await open(url);
    subprocess.on('error', () => {
      printInfo(messages.failed);
    });
  } catch {
    printInfo(messages.failed);
  }
}
