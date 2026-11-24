# Contributing

Thanks for looking. The project is small on purpose; `DESIGN.md` explains how it works and why.

```sh
pip install -e ".[dev]"          # the agent + web server + test libraries
python tests/test_loop.py        # the engine, with fake models: no API key, no network
python tests/test_tools.py       # tool names, manuals, input rules and error messages
python tests/test_server.py      # the web server, with the scripted demo model

cd ui
npm install
npm run typecheck && npm test    # types and unit/component tests
npm run build                    # builds ui/dist, which the server serves
npm run e2e                      # real browser, real server, scripted demo model
```

Working on the UI with hot reload: start the server with `MINI_HARNESS_TOKEN=dev MINI_HARNESS_DEV_ORIGINS=http://localhost:5173
python3 agent.py --ui --demo --no-open`, then `npm run dev` in `ui/` and open `http://localhost:5173/?token=dev`.

Ground rules:

- Anything that could run a command, write a file or show a file goes through the permission gate (`permissions.py`, `safety.py`).
  Don't add a way around it, and add a test next to the behaviour you change.
- Every tool call gets an answer, and every error says what to try next (see "Tool patterns" in `DESIGN.md`).
- Keep `DESIGN.md` up to date when you change a decision.
- Before building or changing UI, read "Web UI rules" in `DESIGN.md`.
