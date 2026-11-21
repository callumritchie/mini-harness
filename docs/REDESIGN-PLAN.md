# Mini Harness UI redesign: implementation plan (direction A)

Designs: the "Mini Harness redesign" canvas (https://claude.ai/code/artifact/9949cdbe-2a1b-4244-a896-a19b8349d205).
Tokens: `docs/redesign-tokens.css`. Constraints: `docs/UX-SPEC.md`. Baseline: `docs/UI-CURRENT.md`.

This is a restyle plus a few new components. Nothing here needs a new dependency, a web font or a CDN. Each phase is
one reviewable change that leaves `npm test`, `npm run typecheck` and `npm run e2e` (light and dark) passing. Where a
phase has to change a test, the test change is listed and is deliberate.

---

## What the designs get wrong about the code (fixed on the canvas, noted here)

- **Enter on the permission dialog denies.** Deny has focus, so Enter activates Deny; the e2e test relies on it. The
  dialog boards now say "Esc or Enter denies". Do not add a handler that swallows Enter.
- **`permission_request` has no tool id.** The "you allowed / judge allowed / you denied" tags on tool rows can't be
  matched to a row reliably today (see Server asks).
- **There is no "ran in parallel" signal.** The client sees consecutive `tool_call`s, not whether they came from one
  reply. Group labels say "3 subagents" / "4 steps", not "in parallel", unless the server adds it.

---

## Phase 1: tokens and base styles

Files: `src/styles.css` only.

1. Replace the two `:root` blocks with `docs/redesign-tokens.css`. Same variable names and meanings, plus new ones.
2. Base type: body text 13px (was 14px), system stack from `--font-ui`; code 12px from `--font-mono`.
3. Sidebar background `var(--sunken)` → `var(--bg)`. Selected session: `--hover` fill with an inset `--line-strong`
   ring instead of `--accent-soft`.
4. Form fields (`.pop select`, `.ask-form input`, `.dialog label input/textarea`, `.context .ctl input`) get
   `border-color: var(--field-line)`; contrast for field borders fails 3:1 today.
5. Focus: keep `--focus` and `:focus-visible`; add `.composer .box:focus-within { box-shadow: var(--focus) }` so the
   ring shows on the whole message box.

Tests: none change. Regenerate screenshots (`SCREENSHOTS=1 THEME=light|dark npm run e2e`) and eyeball them.

## Phase 2: the shell (frame, raised panel, sidebar)

Files: `App.tsx`, `Sidebar.tsx`, `styles.css`.

1. `App.tsx`: wrap `<main>` and `<RightPanel/>` in `<div className="shell">` (rounded `--radius`, `--panel`,
   1px `--line`, 8px margin from the window edge). `.main` keeps `container: main / inline-size`.
2. Allow mode: `.shell.allow { border-color: var(--bad) }`, set from `info.permissions`.
3. Sidebar:
   - Brand row: logo + project folder name (full path in `title`). "Mini Harness" moves to the window title.
   - "New session" becomes a quiet bordered button with `⌘N` shown (add the shortcut in `App.tsx`; it is blocked while
     running, same as the button).
   - A small actions group: "Start a goal…" (`/goal`) and "Compact now" (`/compact`), both disabled while running.
   - Group labels "Today" / "Earlier" in sentence case with a count; rows keep title + `time · prompts · cost`. A GOAL
     tag on rows whose title starts with `GOAL:` (title text only; no protocol change).
   - Footer: `AGENTS.md loaded · N skills · N MCP tools` as small chips.

Tests: e2e `getByRole("button", { name: /New session/ })` still matches. Component tests unaffected.

## Phase 3: top bar

Files: `TopBar.tsx`, `SettingsMenu.tsx`, `styles.css`.

1. Left: breadcrumb `project / session title` (title from the `current` row in `sessions`; falls back to project).
2. Merge the model chip into the Settings button: `[model | cost | context bar + 10.6k / 150k]`. Keep
   `aria-label="Settings"`, the popover's `role="dialog"` name "Settings", and the `.cost` class (e2e uses all three).
   Cost rules unchanged: "cost unknown", never $0, "≥ $x · incomplete" when `complete` is false, note in `title`.
3. Keep the 3px `.contextbar` under the bar (it is the only context signal once the numbers drop at narrow widths).
4. Container queries keep today's shedding order: context numbers, then model, then DEMO. The permission control
   never drops.

Tests: none change if names/classes above are kept.

## Phase 4: permission mode (shield menu + Allow confirmation)

Files: new `PermissionMenu.tsx`, new `ConfirmAllow.tsx`, `TopBar.tsx`, `Composer.tsx`, `store.ts`, `styles.css`.

1. `PermissionMenu`: one button showing the current mode (grey Ask, amber Judge, red Allow; shield icon as inline SVG),
   `aria-haspopup="menu"`, label "Permission mode: Judge". Opens a `role="menu"` with three `menuitemradio`s
   (`aria-checked`), each with the sentence from `info.mode_help[mode]`. Arrow keys move, Enter/Space picks, Esc closes
   and returns focus to the button.
2. Picking Allow opens `ConfirmAllow` (replaces `window.confirm`): `alertdialog`, focus on "Keep <mode>", Esc and
   Enter keep the current mode, only a click on "Turn on Allow" sends `set_permissions allow`. Put `confirmAllow:
   boolean` in the store so the reducer stays the source of truth.
3. While `permissions === "allow"`: a strip above the composer, "Allow is on: nothing is asked. Commands run as you."
   with a "Switch to Ask" button, plus the red shell border from phase 2.
4. `/permissions allow` typed in the composer goes through the same confirmation.

Tests to change (deliberately):
- e2e: replace `getByRole("button", { name: "judge" })` + `aria-pressed` with: open `getByRole("button", { name:
  /Permission mode/ })`, click `getByRole("menuitemradio", { name: /Judge/ })`, assert the button's name contains
  "Judge". UX-SPEC §8 lists `aria-pressed` on the switch; update that line.
- New component tests: Allow needs a click on "Turn on Allow"; Esc and Enter keep the old mode; `/permissions allow`
  opens the confirmation.

## Phase 5: chat items and tool cards

Files: `Chat.tsx`, `Message.tsx`, `ToolCard.tsx`, new `ToolGroup.tsx`, new `src/lib/group.ts`, `styles.css`.

1. `lib/group.ts`: a pure `groupItems(items)` that folds runs of consecutive `tool` items into one group (and leaves
   everything else alone). Unit-test it; `Chat` renders groups with `ToolGroup`.
2. `ToolGroup`: one bordered container; header only when the run has 2+ items ("3 subagents" when all are
   `subagent`, else "4 steps"), with a done count. Rows are `ToolCard`s.
3. `ToolCard` row: status (spinner / ✓ / ✕), an inline SVG icon per tool (replaces the glyph map), the server's
   `display`, a short outcome, chevron.
   - Outcome: writes/edits show `+a −d` from the `changes` store; a failed call shows the first line of its error
     under the row (the "what to try next" sentence), muted red, no red border. Other tools show nothing extra
     rather than parsing result text.
   - Expanded: result first (with "Copy output"), input JSON behind "Show input", the 4,000-character cut-off and
     "Show the other N characters" unchanged. MCP results keep their provenance first line visible.
   - Keep `.tool`, `.tool.error`, `.tool-display`, and the "View diff" label (both test suites use them). Rename to
     "Open in Changes" only together with those tests.
4. User messages become left-aligned cards (`--user`, 1px `--line`, radius 8) with a small avatar; keep
   `.msg.user .bubble` on the text element for the e2e test.
5. "Working…" line keeps its spinner. Notices stay dim single lines for now (phase 8 groups some).

## Phase 6: dialogs and the ask card

Files: `PermissionDialog.tsx`, `AskCard.tsx`, `GoalDialog.tsx`, `styles.css`.

1. Permission dialog per the "Approval dialog variants" board: icon tile + server `title` + "The agent is paused
   until you answer" + a mode badge; `pre.action` unchanged (full text, wraps, never cut); findings as a warning panel
   (`--warn-soft`), the `⟨U+…⟩` markers highlighted in the action only by wrapping matches of `⟨…⟩` in `<mark>`,
   never altering text; `reasons` under "Why you're being asked"; `note` as a quoted judge panel. Footer: "Esc or
   Enter denies", Deny (filled, focused), Allow (outlined). Keep `role="alertdialog"`, `pre.action`, and the
   findings text `Hidden: …` (component test).
2. Ask card per the tool-card board: "The agent is waiting for your answer", numbered choices with key hints, free
   text, Answer and Skip. Keep `.ask-q`, `.choices button`, placeholder "Your answer" and the "Send" label used by the
   component test, or update that test with the label change.
3. Goal dialog: same copy as today plus the Ask-mode warning panel from the "Session states" board.

## Phase 7: side panel

Files: `RightPanel.tsx`, `FilesPanel.tsx`, `ChangesPanel.tsx`, `ContextPanel.tsx`, `styles.css`.

1. Tabs as a segmented control inside a `--bar-h` header; keep `role="tab"`, names "Files", "Changes" (with the
   `.count` badge), "Context".
2. Files: a client-side filter box; NEW / M markers from the `changes` store; secret nodes stay `disabled` (e2e checks
   it) with a lock icon and "Locked" in the accessible name; the viewer's back button becomes an icon with
   `aria-label="Back to files"` (update the e2e step that clicks "← Files"); line numbers in `--muted`.
3. Changes: rows with `+a −d`, two line-number columns in the diff, "Copy diff", and the empty / resumed copy from the
   board. Keep `.diff .row.add`, `.diff-head .tag` ("new file", "modified").
4. Context: the three cards (last request, breakdown with small items nested under "Conversation", compaction). Keep
   the text "Tool definitions".

## Phase 8: states

Files: `Message.tsx`, `Chat.tsx`, `App.tsx`, `Welcome.tsx`, new `GoalCard.tsx`, `styles.css`.

1. Turn endings from `done`: Stopped / Not finished / Cut off / Error as one bordered line each, with the next step
   ("type continue"). Keep the exact "Stopped. That turn was dropped" text (e2e).
2. Retry notices (`Trying again in`) as a quiet line with a retry icon.
3. Compaction: the in-progress notice with a spinner; the "compacted into a summary" notice as a divider; the summary
   item stays a `<details>`.
4. Goal: a card pinned above the thread while a goal runs, fed by notices that start with `goal` / `check` /
   `reviewer` (prefix match only, no deeper parsing); `GOAL DONE` / `GOAL NOT DONE` results as outcome cards. If the
   structured goal events below land, switch the card to them and drop the prefix matching.
5. Disconnected banner in accent-soft (not warn orange) with a spinner; "Can't send while disconnected" placeholder.
6. Welcome: left-aligned, project name in the heading, no-key warning panel, starters keep their titles ("Explore this
   project" is clicked by e2e) and still only fill the box, shortcut hints.

## Phase 9: narrow widths

Breakpoints stay at 1100px (side panel → drawer) and 760px (sessions → drawer). At 760px and below: the shell loses
its margin and radius, drawers use `--scrim`, and the composer footer hint hides (as today). Check 420px by hand:
breadcrumb truncates, Settings shows cost only, permission button stays.

## Phase 10: finish

- Update `docs/UI-CURRENT.md` to describe the new UI, and UX-SPEC §8's accessibility list (menu instead of
  `aria-pressed`).
- Regenerate `docs/screenshots` in light and dark.
- Run the contrast check over the built CSS once (every text/background pair the tokens produce).

---

## Phase 11: refinements from the built-vs-design review

Source: the "Built vs design" board on the canvas (pins 1–21), from the e2e screenshots after phase 10. Do 11a and
11b first; 11c makes the next review cover every state. Keep the same rule: tests green after each part.

### 11a: design gaps (CSS and markup; no behaviour change)

1. **Section labels in sentence case.** Drop `text-transform: uppercase` and letter-spacing from every eyebrow label
   (Context cards, permission dialog "Permission needed", ask card "The agent is waiting for your answer"). Use
   `--fs-xs`, weight 500, `--muted`. (pins 5, 17)
2. **Tool-row chevron.** Replace the glyph that renders as a dot with an inline SVG chevron: right when closed, down
   when open, `--muted`, 12px. (pin 1)
3. **Stop button is neutral.** `--raised` fill, 1px `--line-strong`, `--text`, a filled square icon. Red is kept for
   Allow mode and errors only. Re-check contrast after the change (the phase 10 fix was for the red fill). (pin 16)
4. **Deny is neutral, not accent.** Deny: `--raised` fill with `--line-strong` border, weight 600, and the focus ring.
   Allow: outlined, normal weight. Neither uses `--accent` as a fill. (pin 12)
5. **Ask in the top bar is quiet.** Ask: `--hover` fill, `--line-strong` border, `--text-2`. Judge and Allow keep
   their colours. Check the bright outline in the screenshots isn't a focus ring left on the button by the test
   clicking it; if it is, it's correct `:focus-visible` behaviour only for keyboard focus. (pin 13)
6. **Context reading back in the Settings button.** After the cost: a divider, a 36×4px bar and `10.6k / 150k`
   (`formatTokens`). Keep the container-query order: these drop first. (pin 4)
7. **Context tab "Last request" card.** One large number (`--fs-xl`, weight 600, tabular) + "tokens · N% of {window}
   window" (omit the window part when `window` is null) + a second line "N% of the {limit} compaction limit". (pin 6)
8. **Thousands separators** in the "Compact at" input display and anywhere tokens are shown (`toLocaleString()`;
   parse with separators stripped). (pin 7)
9. **Session times.** Today: time only (`timeStyle: "short"`). Earlier: date only (`dateStyle: "medium"`). (pin 9)
10. **Files tree.** No "·" bullets; secrets get a lock icon at the right edge and "Locked" in the accessible name;
    keep `disabled` (e2e). (pin 20)

### 11b: edge cases the spec didn't cover (behaviour; add these rules to UX-SPEC)

11. **Denied and failed results are written for the model.** A tool row must not show raw result text as its summary
    line when the call was denied. Detect the denial (the store already knows the user answered `false` to the open
    permission; until the server sends `tool_id`, treat an error result that arrives right after a denial as that
    call) and show "You denied this." / "The judge denied this." in `--muted`. Other errors keep the first line of
    the server's message. The full text stays in the expanded view. UX-SPEC: add "Tool results are addressed to the
    model; the row summary is written for the person." (pin 2)
12. **Focus when the agent asks.** When an `ask_user` card appears, move focus to its first choice (or the text field
    when there are no choices). When it closes, return focus to the message box. Keep `role="log"` on the chat;
    announce the question with the card's heading. UX-SPEC: add to §5 next to the approval rules. (pin 15)
13. **Unsent sessions.** A session with 0 prompts: breadcrumb says "New session", and it isn't listed under Today
    until its first message is sent (the current session is still marked in the list once it has a title).
    UX-SPEC §2: add to Session. (pin 19)
14. **Permission titles.** Uppercase the first letter of `title` when the server sends it lower case, and end with "?"
    when it is an action ("Run a command?"). Better long-term: the server sends UI-ready titles; add to Server asks.
    (pin 11)
15. **Provider overhead of zero or less.** Show the row only when overhead > 0; when the estimate exceeds the real
    count, hide the row and change the footnote to "Estimated at about 4 characters per token; the estimate is a
    little above the real count this time." Never show a negative number. UX-SPEC §9: add to Context numbers.
    (pin 8)
16. **Empty sidebar footer.** No AGENTS.md, no skills and no MCP tools: hide the footer and its divider. (pin 10)

### 11c: make every state reviewable

Demo mode only reaches six states, so most of the canvas never gets a screenshot. Add demo keywords in `demo.py`
(scripted, no cost) and screenshot steps in `e2e/ui.spec.ts`:

| Keyword | Demo does | Screenshot |
|---|---|---|
| `hidden` | `bash` with a U+202E in the command | `07-permission-hidden` |
| `helpers` | three `subagent` calls in one reply | `08-subagents` |
| `fail` | `edit_file` on a file not read yet (error with advice) | `09-tool-failed` |
| `cut` | reply that ends with `stop_reason: max_tokens` | `10-cut-off` |
| (existing) `list` | `glob` | `11-tool-group` |
| — | viewport 1024, 700 and 420 wide on the resumed session | `12-narrow-1024`, `13-narrow-700`, `14-narrow-420` |
| — | Allow mode on (confirm dialog, then the red strip) | `15-allow-confirm`, `16-allow-on` |

If the demo model can run a goal, add `17-goal-running` and `18-goal-result`; if not, note it as a gap. Keep the new
keywords out of the starter prompts.

After 11c, regenerate `docs/screenshots` (light and dark) and ask for a fresh built-vs-design review.

## Phase 12: close the polish gap to the boards

Source: a side-by-side of every board's inline values against `styles.css` and the components (three passes: chrome, tool cards and
dialogs, side panel and states). The plan was approved as `~/.claude/plans/composed-enchanting-boot.md`; in short:

- **12a Foundations:** the design's missing greys and tints as tokens; one 16-grid icon set (`Icon.tsx`) and an SVG spinner; `.btn` /
  `.chip` / `.field` / `.is-selected` primitives; no 11.5/12.5/13.5/16px or 550/650/700 weights; radii 4/5/6/8/10/12.
- **12b Chrome:** sidebar (H tile, session search, actions card, GOAL tag fix), top bar order and neutral Settings button, agent column with
  an "H" mark, in-box composer footer, welcome naming the project, gate card, narrow drawers.
- **12c Tool rows and dialogs:** grid rows with outcome and approval chips, denied/waiting states, expanded footer and inline diff,
  subagent group header, ask card with number keys, paused strip, sectioned permission dialog, Allow confirmation bullets, menu with icons.
- **12d Side panel and states:** tabs, tree, viewer cards and "See changes", hunk headers, Context cards, goal card with steps and Stop goal,
  goal results with Run goal again / Show all rounds, one-line turn endings.
- **12e Server asks** (below), all four, additive; the terminal prints what it always did.
- **12f** contrast check, screenshots, docs.

Kept deliberately different from the boards: no chevron on the brand row (there is no project menu), a person icon instead of a user
initial, no wrapping in the code viewer, setup items listed separately from "Conversation" in the Context breakdown (the board nested them
by mistake).

## Server asks (small, additive; none weakens UX-SPEC §5)

1. **`tool_id` on `permission_request`**, and a `decided_by: "rule" | "judge" | "user" | null` on `tool_result`.
   Enables the "who approved" tag on every tool row.
2. **`parallel_group` on `tool_call`** (same id for calls from one reply). Enables "in parallel" labels honestly.
3. **UI-ready permission titles** (sentence case, as a question), so the client doesn't rewrite them.
4. **Structured goal and subagent events** (`goal_round`, `check_result`, `reviewer_verdict`, `subagent_step`,
   `subagent_finish`) as listed in UX-SPEC §9. Replaces prefix matching in phases 5 and 8.

The UI ships without them; each one only upgrades a label. **All four are done in phase 12e** (as `approval` rather than
`decided_by`, plus `outcome` and `mcp` on `tool_result` and `hidden_explanation` on `permission_request`); see UX-SPEC §4.

## Order and size

Phases 1–3 are mostly CSS and can land together. 4 and 6 touch safety UI: land them separately, each with its tests.
5, 7 and 8 are independent of each other after 2. In phase 11, items 3–5 (Stop, Deny, Ask) and 11–12 touch the
safety UI and should be their own commit.
