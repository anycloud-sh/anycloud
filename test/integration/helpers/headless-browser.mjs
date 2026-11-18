// PTY preload: make browser-dependent CLI flows behave like a headless Linux
// API host regardless of the platform running the integration test. This keeps
// `notifications connect slack` at its prompt without opening a real browser.
Object.defineProperty(process, 'platform', {
  configurable: true,
  value: 'linux',
});
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
