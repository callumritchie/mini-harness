import { defineConfig } from "@playwright/test";

// The browser tests drive the real server in --demo mode (a scripted model, no API key, no cost) with a pinned token.
const PORT = 8799;
export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", viewport: { width: 1440, height: 900 },
    colorScheme: process.env.THEME === "dark" ? "dark" : "light",
  },
  webServer: {
    command: `python3 ../agent.py --ui --demo --no-open --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/?token=e2e-token`,
    env: { MINI_CLAUDE_TOKEN: "e2e-token", MINI_CLAUDE_HOME: "/tmp/mini-claude-e2e-home" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
