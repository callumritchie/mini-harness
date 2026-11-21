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
  await expect(page.getByText(/What should we work on/)).toBeVisible();
  await expect(page.locator(".badge.demo")).toBeVisible();
  expect(page.url()).not.toContain("token="); // the token is removed from the address bar
  await page.screenshot({ path: shot("01-empty") });

  // a starter fills the message box without sending anything; the settings popover shows the model
  await page.getByRole("button", { name: /Explore this project/ }).click();
  await expect(page.getByPlaceholder(/Message Mini Harness/)).toHaveValue(/Look around this project/);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("combobox").first()).toHaveValue("claude-sonnet-5-5");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

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
  await page.getByRole("button", { name: "Back to files" }).click();

  // Stop
  await box.fill("long");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped. That turn was dropped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // settings and the context panel
  await page.getByRole("button", { name: /Permission mode/ }).click();
  await page.getByRole("menuitemradio", { name: /Judge/ }).click();
  await expect(page.getByRole("button", { name: /Permission mode/ })).toContainText("Judge");
  await expect(page.getByRole("button", { name: /Permission mode/ })).toHaveAccessibleName(/Judge/);
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByText("Tool definitions")).toBeVisible();
  await page.screenshot({ path: shot("05-context") });

  // sessions: new, then back to the first
  await expect(page.locator(".sessions button").first()).toContainText("hello");
  await page.getByRole("button", { name: /New session/ }).click();
  await expect(page.getByText(/What should we work on/)).toBeVisible();
  await page.locator(".sessions button", { hasText: "hello" }).click();
  await expect(page.locator(".msg.user .bubble").first()).toHaveText("hello");
  await page.screenshot({ path: shot("06-resumed") });

  // every other state the design covers (the demo keywords are listed in demo.py). Back to Ask first: the judge answers for itself here.
  const modeButton = page.getByRole("button", { name: /Permission mode/ });
  await modeButton.click();
  await page.getByRole("menuitemradio", { name: /Ask/ }).click();
  await expect(modeButton).toContainText("Ask");
  const say = async (text: string) => { await box.fill(text); await box.press("Enter"); };
  const idle = () => expect(page.getByRole("button", { name: "Send" })).toBeVisible(); // Send is back once the task has finished

  await say("hidden");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre.action mark")).toContainText("U+202E");
  await expect(dialog.getByText(/Hidden:/)).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Run a command?");
  await page.screenshot({ path: shot("07-permission-hidden") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await idle();
  await expect(page.locator(".tool.denied .chip").last()).toHaveText("you denied");

  await say("helpers");
  await expect(page.locator(".toolgroup-head").last()).toContainText("3 subagents");
  await idle();
  await expect(page.locator(".toolgroup-head").last()).toContainText("3 / 3 done");
  await page.screenshot({ path: shot("08-subagents") });

  await say("fail");
  await expect(page.locator(".tool.error .tool-err").last()).toContainText("read_file");
  await idle();
  await page.screenshot({ path: shot("09-tool-failed") });

  await say("cut");
  await idle();
  await expect(page.locator(".ending.cutoff")).toBeVisible();
  await page.screenshot({ path: shot("10-cut-off") });

  await say("list the files");
  await expect(page.locator(".tool-display", { hasText: "glob(*)" }).last()).toBeVisible();
  await idle();
  await page.screenshot({ path: shot("11-tool-group") });

  for (const [width, name] of [[1024, "12-narrow-1024"], [700, "13-narrow-700"], [420, "14-narrow-420"]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload(); // a fresh load at this width: the drawers start closed, and the session comes back from the server
    await expect(page.locator(".msg.user .bubble").first()).toHaveText("hello");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: shot(name) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.locator(".msg.user .bubble").first()).toHaveText("hello");

  await modeButton.click();
  await page.getByRole("menuitemradio", { name: /Allow/ }).click();
  const confirm = page.getByRole("alertdialog", { name: /Turn on Allow/ });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: /Keep/ })).toBeFocused();
  await page.screenshot({ path: shot("15-allow-confirm") });
  await confirm.getByRole("button", { name: "Turn on Allow" }).click();
  await expect(page.locator(".allow-strip")).toBeVisible();
  await expect(page.locator(".shell.allow")).toBeVisible();
  await page.screenshot({ path: shot("16-allow-on") });
  await page.getByRole("button", { name: "Switch to Ask" }).click();
  await expect(page.locator(".allow-strip")).toHaveCount(0);

  // a goal: the demo model never claims it is done, so it stops at the turn limit
  await page.getByRole("button", { name: /Start a goal/ }).click();
  const goalForm = page.getByRole("dialog", { name: /unattended/ });
  await expect(goalForm.getByText(/In Ask mode/)).toBeVisible();
  await goalForm.getByLabel("Goal").fill("Make the project tidy");
  await goalForm.getByLabel(/Turn limit/).fill("2");
  await goalForm.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".goalcard")).toContainText("Make the project tidy");
  await page.screenshot({ path: shot("17-goal-running") });
  await idle();
  await expect(page.locator(".outcome.notdone")).toContainText("GOAL NOT DONE");
  await page.screenshot({ path: shot("18-goal-result") });

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
