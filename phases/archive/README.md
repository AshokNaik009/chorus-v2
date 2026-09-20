# Archived phase docs — 1 through 5

These phases are **done and shipped**. They are kept because their reasoning is
still load-bearing — `PLAN.md` cites PHASE-2 for the renderer decision, PHASE-4
for the `core/` line-count estimate, PHASE-5 Part D for the `leap-chorus` rename
checklist, and `bench/RESULTS.md` cites PHASE-4 criterion 7 for what the
benchmark draws.

**Do not run them, and do not re-measure against them.** Their line counts and
paths were checked on 2026-09-19 against herdr `3f2a6e74` and orca `061a756b84`;
both checkouts have moved since. What is true about the code they produced lives
in the code, in `HANDOFF.md`, and in git history.

A live phase is one of `../PHASE-7.md` … `../PHASE-10.md`. Phase 6 (remote SSH
attach) is still reserved and has never been written.

| # | Phase | Outcome |
|---|---|---|
| 1 | Daemon + PTY survival | shipped — the daemon outlives its launcher |
| 2 | TUI client + render + benchmark | shipped — `bench/RESULTS.md` is its artifact |
| 3 | Input parsing | shipped — legacy and kitty protocols |
| 4 | Session model + API | shipped — it is a multiplexer |
| 5 | Agents + detection + packaging | shipped, with **criterion 2 still open**: detection has never been checked against a running agent, and three of six platform slots were never built. See `HANDOFF.md`. |
