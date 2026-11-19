import { expect, test } from "@playwright/test";

const URL = "/?token=e2e-token";
const THEME = process.env.THEME ?? "light";
const SHOTS = process.env.SCREENSHOTS ? "../docs/screenshots" : "test-results/screenshots";
const shot = (name: string) => `${SHOTS}/${THEME}-${name}.png`;

test.describe.configure({ mode: "serial" });

test("the whole demo walk-through", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(URL);
  await expect(page.getByText("What should we work on?")).toBeVisible();
  await expect(page.locator(".badge.demo")).toBeVisible();
  expect(page.url()).not.toContain("token="); // the token is removed from the address bar
  await page.screenshot({ path: shot("01-empty") });

  // streaming chat, with markdown and a code block
  const box = page.getByPlaceholder(/Message Mini Harness/);
  await box.fill("hello");
  await box.press("Enter");
  await expect(page.locator(".msg.user .bubble")).toHaveText("hello");
  await expect(page.locator(".markdown strong").first()).toHaveText("demo model");
  await expect(page.locator(".markdown pre code")).toContainText('print("hello from the demo")');
  await expect(page.locator(".cost")).toContainText("$");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // a write: a tool card, no question (inside the project), and a diff in Changes
  await box.fill("create a file");
  await box.press("Enter");
  await expect(page.locator(".tool-display", { hasText: "write_file(demo.py" })).toBeVisible();
  await expect(page.locator(".tab, .tabs button", { hasText: "Changes" }).locator(".count")).toHaveText("1");
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.locator(".diff .row.add").first()).toBeVisible();
  await expect(page.locator(".diff-head .tag")).toHaveText("new file");
  await page.screenshot({ path: shot("02-diff") });

  // a delete asks, with the exact command: Deny keeps the file
  await box.fill("delete it");
  await box.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre.action")).toContainText("rm demo.py");
  await expect(dialog.getByText("rm is not on the read-only list")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Deny" })).toBeFocused();
  await page.screenshot({ path: shot("03-permission") });
  await page.keyboard.press("Enter"); // Enter on the focused Deny button must not approve
  await expect(dialog).toBeHidden();
  await expect(page.locator(".tool.error").last()).toBeVisible();

  // ...and Allow removes it
  await box.fill("delete it");
  await box.press("Enter");
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("That didn't run")).toHaveCount(1); // only the denied one
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.locator(".tree .node", { hasText: "README.md" })).toBeVisible();
  await expect(page.locator(".tree .node", { hasText: "demo.py" })).toHaveCount(0);

  // a question with choices
  await box.fill("ask me to choose");
  await box.press("Enter");
  await expect(page.locator(".ask-q")).toHaveText("Python or Go?");
  await page.screenshot({ path: shot("04-question") });
  await page.locator(".choices button", { hasText: "Go" }).click();
  await expect(page.getByText(/You picked/)).toBeVisible();

  // secrets are listed but never shown
  await expect(page.locator(".tree .node", { hasText: ".env" })).toBeDisabled();
  await page.locator(".tree .node", { hasText: "README.md" }).click();
  await expect(page.locator(".viewer .code")).toContainText("Demo folder");
  await page.getByRole("button", { name: "← Files" }).click();

  // Stop
  await box.fill("long");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped. That turn was dropped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // settings and the context panel
  await page.getByRole("button", { name: "judge" }).click();
  await expect(page.getByRole("button", { name: "judge" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByText("Tool definitions")).toBeVisible();
  await page.screenshot({ path: shot("05-context") });

  // sessions: new, then back to the first
  await expect(page.locator(".sessions button").first()).toContainText("hello");
  await page.getByRole("button", { name: /New session/ }).click();
  await expect(page.getByText("What should we work on?")).toBeVisible();
  await page.locator(".sessions button", { hasText: "hello" }).click();
  await expect(page.locator(".msg.user .bubble").first()).toHaveText("hello");
  await page.screenshot({ path: shot("06-resumed") });

  // slash commands
  await box.fill("/perm");
  await expect(page.getByRole("option", { name: /permissions/ })).toBeVisible();
  await box.fill("/help");
  await box.press("Enter");
  await expect(page.locator(".notice").last()).toContainText("/compact");

  expect(errors).toEqual([]);
});

test("a wrong token gets nothing, and the page says what to do", async ({ page, request }) => {
  expect((await request.get("/api/info")).status()).toBe(401);
  expect((await request.get("/api/info", { headers: { Authorization: "Bearer wrong" } })).status()).toBe(401);
  await page.goto("/");
  await expect(page.getByText("needs the private address")).toBeVisible();
});
