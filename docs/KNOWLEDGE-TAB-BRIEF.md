# Knowledge tab: design brief

Intent and constraints for redesigning the Knowledge tab (`ui/src/components/KnowledgePanel.tsx`, graph drawing in `ui/src/components/GraphCard.tsx`). Written to explore design options in a separate design artifact; the behaviour it describes is specified in DESIGN.md ("Search by meaning", "Knowledge graph").

## What the product is
Mini Harness is a local coding-agent app: a chat with an AI model that can read and edit a project. It has three columns: sessions on the left, chat in the middle, and a right panel with tabs (Files, Changes, **Knowledge**, Context). The audience is developers who are curious about how the agent "knows" the codebase but aren't search or graph experts.

## What the Knowledge tab is for
The agent has two tools for finding its way around the project:
- **search_docs**: finds passages of text and code that are relevant to a question.
- **explore_graph**: follows links between named things (modules, classes, functions, Markdown headings, concepts), for example "what calls `check_cancel`, and what does that call?"

The Knowledge tab is a **window onto what those tools can see**. It also holds the controls that improve them, some free and some paid. People should leave it able to answer three questions: *What does the agent know about my project? Is it up to date? How do I make it smarter, and what will that cost?*

## The underlying model (what designs must represent truthfully)
- **Index**: every text and code file split into **passages** (about 592 here, from 130 files). Updates happen automatically as files change. The manual "Update index" only matters when you want it to happen now. The update is fast (0.1s) and free.
- **Keyword search**: always on, free, finds exact words.
- **Search by meaning** (optional): a small local model (it runs on the user's machine, nothing is sent anywhere, one-off download) turns each passage into a vector, so a search for "stop the agent" finds `check_cancel` even though the words differ. States: *not installed* (a Python library is missing; needs a terminal command and a restart) → *off* (library present, model not downloaded) → *embedding N of M* → *on*.
- **Knowledge graph**: "things" and "links" between them.
  - The **code + structure layer** is built automatically and free from parsing code (imports, calls, defines, inherits) and Markdown headings. Here: 860 things, 2,335 links.
  - The **prose layer** is optional and **costs money**: a cloud model (Haiku) reads each prose passage once and pulls out the concepts and how they relate. The user sees an estimate (passages, tokens, about $) before anything is sent. Results are cached, so later builds only pay for new passages. After a build here: 1,690 things, 3,707 links, $0.05. Links from this layer are a model's reading, not fact.
- **Lookup**: type a name and get that thing plus its neighbours. The match is exact first, then the end of a dotted name, then by words, and near-misses are offered. The lookup follows links in both directions, up to **3 hops** and **40 things** drawn.
  - **Hops** = how far out to go. 1 hop shows what it directly touches. 2 hops adds what *those* touch, and so on. More hops gives more context but more clutter. In the screenshot, 3 hops from `check_cancel` gave 66 links and 40 unlabelled dots.

## Current problems (from user testing)
1. **"Not installed" is a dead end.** It doesn't say which Python, doesn't show the command in a form you can copy, and doesn't say what you gain. It reads like something is broken.
2. **"Update index" and "Build prose graph…" sit side by side as if they were equals.** One is free, instant and rarely needed. The other is optional, paid and slow. Neither button says what it changes, what it costs, or when you'd want it. It's also unclear that "Update index" refreshes the graph too.
3. **"Look something up" has no stated purpose.** It isn't clear whether it's search, a debugger or a sitemap. It also doesn't say that this is exactly what the agent sees when it calls explore_graph.
4. **The graph picture can't be read.**
   - Colours encode the kind of thing (function, class, symbol, concept…), but there is no legend.
   - Rings encode hop distance, but nothing says so.
   - Above 14 nodes the labels disappear, and only the centre is named.
   - Lines from the chosen thing and lines between neighbours look the same.
   - Nothing marks which links are code facts and which are a model's reading.
   - It says "66 links" but draws 40 things and doesn't say what was left out.
5. **The hops control comes without a reason.** It's a bare dropdown with no explanation of the trade-off and no preview of how much it will add.
6. **The link list is dense.** Rows like "run_parallel → tools.Interrupted class agent.py:251–310" mix direction arrows, short and full names, kinds and file ranges with little hierarchy. Rows are grouped by relation ("calls 39"), but the heading is easy to miss.

## Goals for the redesign
- Each section starts with **what this is for, in one line**, written in plain language and focused on the user's benefit.
- **State, cost and privacy are always visible** for anything that sends data out or spends money.
- Free and automatic things look ambient. Paid, opt-in things look deliberate.
- The graph can be read **without prior knowledge**: a legend, hop rings that explain themselves, distinct direction and provenance (code vs model), and an honest note when things are truncated.
- Hops are framed as a **zoom level** ("direct links / their links / wider"), with counts shown before or as you change it.
- Lookup is clearly tied to the agent: "This is what the agent sees when it explores the graph." Clicking any node re-centres on it.
- Works in a narrow right panel (about 360–480px). Light and dark themes.

## Things to explore (open questions for design options)
- Should the tab lead with **status** (counts, freshness) or with **lookup** (the thing people actually use)?
- Should "Search by meaning" be a setup checklist (install → download → embed) rather than a chip plus paragraph?
- Should "Update index" disappear into an automatic "Up to date · 2 min ago ↻", with the prose graph becoming its own opt-in card that shows the cost?
- Graph views: radial rings (current), a tree in two columns ("callers ← X → callees"), or a list first with a small diagram. Which is easiest to read at 40+ nodes?
- How should "a model's reading" be shown (dashed lines, a badge, a filter toggle)?
- Should the relation (calls / imports / mentions / defines) be a filter as well as a group heading?

## Real data to design with
- Counts: 130 files · 592 passages · 860 things / 2,335 links (code) → 1,690 / 3,707 after the prose build · prose build cost $0.0548 for 77 passages.
- Lookup `agent.check_cancel` (function), 3 hops, 66 links. Relations seen: `calls` (39). Neighbours include `tools.Interrupted` (class), `agent.run_parallel` (function, calls it), `agent.agent_loop` (function, calls it), `tools.run`, `agent.AnyEvent` (class), `threading.Event` (symbol), `concurrent.futures.ThreadPoolExecutor` (symbol), `agent.prepare`, `agent.tool_list`, `agent.request_body`, `itertools.count` (symbol). Citations look like `agent.py:251–310`.
- Node kinds: module, class, function, section, document, concept, component, symbol.
