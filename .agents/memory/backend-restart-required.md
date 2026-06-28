---
name: Backend changes require manual workflow restart
description: This repl's dev server does not hot-reload server-side code; restart the workflow after editing server/ before testing.
---

# Backend changes need a manual workflow restart

The "Start application" workflow runs the dev server with **no watch/reload**. Only
the frontend hot-reloads (Vite HMR). Editing anything under `server/` leaves the
**old code running in memory** until the workflow is restarted.

**Why:** A backend SQL fix looked correct (verified by importing the module fresh in
a one-off `tsx` script), but the live app kept serving stale results because the
long-running server process was never reloaded. This caused a wasted round-trip with
the user who still saw the old behavior.

**How to apply:** After any edit under `server/`, restart the "Start application"
workflow **before** testing the live endpoint or telling the user it's fixed.
A fresh one-off `tsx -e` import proves the *file on disk* is correct — it does NOT
prove the running server picked it up. Do not rely on platform auto-restart for
backend-only edits in this repl.
