# Mini Harness web UI: how information is displayed today

A description of the **current** UI after the direction-A redesign (`docs/REDESIGN-PLAN.md`, phases 1–12), for use as the baseline in the next
design session. It records what is shown, where, with which data and which rules. Companion to `docs/UX-SPEC.md` (engine, protocol and
safety constraints). Source: `ui/src/` (`App.tsx`, `store.ts`, `components/*`, `lib/*`, `styles.css`). Screenshots: `docs/screenshots/`
(18 states, light and dark; the steps that make them are in `ui/e2e/ui.spec.ts` and use the demo keywords listed in `demo.py`).

---

## 1. Look and layout

- **Frame and shell:** a full-height row on the `--bg` frame: the session sidebar, then a raised, rounded **shell** (`--panel`, 1px `--line`,
  radius 10, 8px from the window edge) holding the main column and the side panel. In **Allow** mode the shell border is red.
- **Tokens:** colours, type and radii come from `docs/redesign-tokens.css` (copied into `styles.css`), including the design's greys and tints
  (`--text-3`, `--control`, `--line-mid`, `--inset`, `--footer`, `--card`, `--brand`, ink and note colours, `--danger-fill`,
  `--accent-surface`). The accent is kept for focus, links and "waiting for you"; selection, the brand, Send, the mini bar and the context bar
  are neutral.
- **Type:** the system stack only. Sizes 10/11/12/13/14/15/17/22px, weights 400/500/600 (700 only in the "H" mark). Code is 12px mono with
  line-height 1.65 in the viewer and diffs.
- **Controls:** fixed heights (`.btn` 30, `.btn-sm` 26, `.btn-xs` 22, `.btn-icon` 28) on a 6px radius; cards and inputs 8px; shell, composer,
  menus and the ask card 10px; dialogs 12px; chips and kbd 4px.
- **Icons:** one set (`components/Icon.tsx`) on a 16-unit grid with 1.5 strokes; a track-and-arc `Spinner`. No text glyphs as icons.
- **Contrast:** checked over the built CSS: every text/surface pair the tokens produce is ≥4.5:1 and field borders ≥3:1, in both themes.

| Column | Width | Collapses |
|---|---|---|
| Session sidebar | 248px (220px under 1100px) | drawer (300px, `--card`, close button, scrim) under 760px; ☰ or ⌘B toggles |
| Main | flex | never |
| Side panel | 400px, drag 280–720px (kept in `localStorage`) | drawer under 1100px (scrim and click-outside under 760px) |

## 2. Sidebar

1. **Brand row:** a neutral "H" tile and the project folder name (full path in `title`).
2. **New session** (quiet, pencil icon, `⌘N`) and a **search** button that opens a field filtering the list by title (Esc closes it).
3. **Actions card:** "Start a goal…" `/goal` and "Compact now" `/compact`, with icons; both disabled while running.
4. **Sessions** under "Today N" / "Earlier N" (count on the right; a divider above Earlier). Today rows show `time · N prompts · $cost`;
   Earlier rows are one line. A **GOAL** tag replaces the `GOAL:` prefix. The current row is a neutral fill with an inset ring. A session
   with no prompt yet is not listed. Empty: "No sessions yet" (or "No session titles match …").
5. **Footer chips** (`AGENTS.md loaded`, `N skills`, `N MCP tools`), hidden when there are none.

## 3. Top bar (46px) and context bar

- **Left:** the sessions toggle (only when the list isn't docked beside the chat), then the breadcrumb `project › session title` ("New
  session" for an unsent one).
- **Right, in order:** the DEMO tag, the Settings button, the permission button and the panel toggle.
- **Settings button** (`aria-label="Settings"`): `model | $cost (mono) | mini bar 10.6k / 150k`. The container query sheds the bar below
  720px, the model below 600px and the tokens below 470px; the cost always stays.
  - Cost rules: "cost unknown" (never $0), and an incomplete-cost marker with its note on hover.
  - It opens a popover (`role="dialog"` "Settings") with Model ("Other…" uses a native prompt) and Effort.
- **Permission button** (`aria-label="Permission mode: Judge"`, `aria-haspopup="menu"`): the mode's icon (shield, shield with a line,
  shield with an x), its name and a chevron. Ask is a quiet grey fill, Judge amber, Allow red.
  - It opens a 380px `role="menu"` of `menuitemradio`s. Each is named by its mode alone, and the server's sentence is its description.
  - The current mode shows "Current". A divider sits above Allow, whose meta reads "Asks to confirm".
  - Arrows move, Enter/Space pick, Esc closes and returns focus to the button.
- **Allow confirmation** (`alertdialog`): what Allow means for this project, as three bullets.
  - Focus starts on "Keep Ask"/"Keep Judge"; Esc and Enter keep the mode.
  - Only a click on the red "Turn on Allow" sends it. `/permissions allow` goes through the same dialog.
- **Context bar:** 2px, neutral fill, amber at ≥80% of the limit; a `progressbar`.

## 4. Chat

A `role="log"` (`aria-live="polite"`) with a 720px column and 20px rhythm. Auto-scroll only while within 80px of the bottom.

- **User message:** a card (`--user`, radius 8) with a 22px person avatar inside it; the text is `.msg.user .bubble`.
- **Agent reply:** everything after a person's message sits in a column beside a 22px "H" mark, which shows once per reply: text, tool
  groups, notices, endings, the "Working…" line and the ask card. Markdown has line-height 1.5, highlighted code with Copy, links opening in a
  new tab, and images replaced by `[image: alt]`.
- **Turn endings** are one bordered line with an icon and a bold lead:
  - **Stopped.** "That turn was dropped from the conversation. Files already written stay on disk."
  - **Not finished:** the reason, then "Type `continue` to pick up from here."
  - **Cut off.** "The reply hit its maximum length. Type `continue` to carry on."
  - **Errors** use the same shape in red.
- **Notices:**
  - Retry: a line with a retry icon.
  - Compacting: a card with a spinner.
  - "Compacted into a summary": a divider.
  - Anything else: a dim line.
  - The text is never changed.
- **Summary:** a `<details>` "Summary the model now works from".
- **Ask card** (accent surface): "The agent is waiting for your answer", the question, 36px choices with number keys, "Or type your own
  answer", Answer and Skip.
  - Keys 1–9 pick a choice, but never while typing or while an approval is open.
  - It takes focus (first choice, or the field) and returns it to the message box when it closes.
- **Paused strip:** while an approval is open, "Waiting for your approval: Run a command?" with Review. Review only moves focus to the
  dialog's Deny.
- **Goal card:** pinned at the top while a goal runs, built from the server's goal events.
  - It shows a GOAL tag, "Round N · working", the goal, "Check `cmd` · up to N turns · can't ask you questions", a list of steps (round
    number, ✓, ✕, or a spinner on the latest), the mode note and **Stop goal**.
- **Goal result:** a card titled "Goal done" (green border) or "Goal not done" (amber border).
  - It shows the reason without the `GOAL …` prefix, "N rounds · $cost" (the cost is the session total at the end minus at the start),
    **Run goal again** (same text, check and limit) and **Show all rounds** (the run's steps).

### Welcome

- A 28px "H" mark and "What should we work on in {project}?".
- "Working with {model}.", followed by what is loaded, and the demo hint.
- A warning panel with an icon when there is no API key.
- Four starters, which only fill the box, and the shortcut keys.

## 5. Tool rows and groups

- **Container:** a run of consecutive calls shares one sunken container. Subagents from one reply (`parallel_group`) get a collapsible
  header: "Ran 3 subagents in parallel · read-only · 3 / 3 done".
- **Row layout:** `[status] [icon] [display, mono, ellipsis] [outcome] [who] [chevron]`.
  - Status: ✓, ✕, a spinner, or the accent dot when the open approval is about this call (matched by `tool_id`).
  - Outcome: the server's few words ("612 lines", "3 matches", "exit 1", "new file", "answered: Go"), or `+a −d` for edits and writes, counting
    **this call's own change** (the Changes tab shows the whole session's).
  - Who: a chip when someone approved it ("you allowed", "judge allowed", "allowed by rule").
- **Denied:** the display is struck through, with a "you denied" or "judge denied" chip. The text written for the model stays in the
  expanded view.
- **Failed:** the first line of the server's message (its "what to try next") sits under the row in a soft red.
- **Subagent rows:** "[n] ↳ latest step · finished: N model calls, $x" under the row, from `subagent_step` and `subagent_finish`.
- **Expanded:** a `$ command` block for bash, then an inline diff of this call's own change (always wrapped, folded context opens in place),
  then the MCP provenance banner and the result. A reloaded transcript has no per-call change, so it shows no inline diff.
  - Its footer holds Copy output, Open in Changes, Show input JSON, and for long output "Showing the first 4,000 characters" + "Show the
    other 9,412".

## 6. Composer

- **Box:** radius 10, `--field-line` border, a 1px accent focus ring, and a two-row textarea.
- **Placeholders:** idle "Message Mini Harness, or / for commands"; running "Working… you can type, but sending waits until this turn ends";
  disconnected "Can't send while disconnected".
- **Footer inside the box:**
  - "/ commands" (puts `/` in the box)
  - a hint ("Enter to send · Shift+Enter for a new line" / "Esc to stop · the turn is dropped")
  - Send (28px neutral, arrow) or Stop (a small neutral button)
- **Above it:**
  - the slash palette when you type `/`
  - when Allow is on, a red strip "Allow is on: nothing is asked. Commands run as you." with Switch to Ask.

## 7. Side panel

- **Tabs:** a content-sized tray (`role="tablist"`): Files, Changes (neutral count), Context.
- **Files:** a filter field with refresh, a tree (26px rows, SVG chevrons, NEW / M in colour on the right, secrets `disabled` with a lock and
  "<name>, Locked"), and a read-only note.
  - **Viewer:** back ("Back to files"), path, line count, Wrap, "See changes" when the file changed this session, and highlighted code.
  - Binary, cut-off and unreadable files show as cards.
- **Changes:** files with `+a −d` (new files: "+N" and NEW).
  - A meta row: the `new file`/`modified` tag, "Since the start of this session · latest version", Copy diff.
  - The diff: a grid of old and new line numbers, a coloured `−`/`+` sign column, the line, and `@@` hunk headers.
    - Removed and added rows are tinted, without syntax colour.
    - When a removed line is replaced by an added one, the words that changed are marked (`--del-strong` and struck through on the
      removed side, `--add-strong` on the added side).
    - Folded context ("⋯ 12 unchanged lines") opens in place.
    - The meta row shows `+a −d` and a **Wrap** toggle (on by default, shared with the file viewer, remembered in this browser). With wrap
      on, long lines wrap under their text and the gutters stay put; with it off they scroll sideways.
  - Empty: a card that says resumed sessions and shell changes aren't tracked.
- **Context:**
  - **Last request:** the number, % of the window and of the compaction limit, and a bar in three neutral segments (setup, conversation,
    provider overhead).
  - **Breakdown:** setup items, then Conversation with its parts nested, then provider overhead (only when above zero; otherwise the
    footnote says the estimate is a little above the real count).
  - **Compaction:** "Auto-compact at" (commits on Enter or blur), Compact now, the count, and a warning with "Set limit" when automatic
    compaction has switched itself off.

## 8. Dialogs

- **Permission dialog:** an `alertdialog` named "Permission needed: {title}", in three sections.
  - **Header:** a tile whose icon follows the kind (terminal, file, plug; a warning tile when there are hidden characters), the server's
    title as a question, a subtitle ("The agent is paused until you answer" / "The judge passed this to you" / "From an MCP server…") and
    a mode badge.
  - **Body:** the exact action in `pre.action`, with `⟨…⟩` markers in `<mark>` and the text unchanged.
    - The findings panel shows "Hidden characters found", the server's explanation, and one "Hidden: …" line per finding.
    - The judge's note sits in a panel before "Why you're being asked".
  - **Footer:** "Esc or Enter denies", a neutral focused **Deny** and an outlined **Allow**. Enter never approves.
- **Goal form:** title and explanation, the Goal field, then "Your check" and "Turn limit" (both optional) side by side, then the Ask-mode
  warning, then Cancel / **Start goal**.
- **Gate page:** a card, "Open Mini Harness from your terminal", with the command.
- **Disconnected:** a banner on the accent surface with a spinner, "Disconnected from the local server. Reconnecting…"

## 9. Data → display map

| Information | Shown in |
|---|---|
| Project | sidebar brand, breadcrumb, welcome, Allow confirmation |
| Session title / unsent session | breadcrumb ("New session"), sidebar rows (unsent ones not listed) |
| Model, cost, context | Settings button; Context tab; Settings popover |
| Permission mode | permission button, Allow strip and red shell, dialog badge, goal card note, goal form |
| Who approved a call | chip on the tool row (`tool_result.approval`) |
| How a call went | outcome on the row (`tool_result.outcome`), `+a −d` for writes |
| Parallel subagents | group header (`tool_call.parallel_group`), rows' step and finish lines (`subagent_step`, `subagent_finish`) |
| Goal progress | goal card and result card (`goal_start`, `goal_round`, `goal_status`, `check_result`, `reviewer_verdict`) |
| File changes | row outcome, Open in Changes, Changes tab, NEW / M in Files, See changes in the viewer |
| Approval requests | dialog + paused strip + waiting row |
| Per-call cost / tokens, timestamps, elapsed time | not shown (not sent) |

## 10. Remaining gaps

1. **No per-turn or per-call cost and tokens**, no timestamps, no elapsed time: the server does not send them.
2. **Sessions:** search filters titles only; there is no rename or delete, and no model or running state on rows.
3. **Skills / MCP names** are counts only.
4. **Custom model id** still uses a native `prompt`.
5. **The brand row has no project menu** (the design's chevron was left out: there is no menu behind it), and the user avatar is a person
   icon rather than an initial (the app does not know the user's name).
6. **The collapsed row** still shows only the start of a long command; the expanded view has the whole command.
7. **Subagent rows** show their last step and the finish line, but not a short result value: the server has no short form of a subagent's
   answer.
8. **Notices after a reload:** transcripts carry tool outcomes but not notices or goal steps, so a resumed session shows its goal results
   without "Show all rounds".
