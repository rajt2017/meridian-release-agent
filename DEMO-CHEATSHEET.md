# Meridian Release Agent — Demo Cheat Sheet

## Opening statement (say this first, from memory)
"I picked Example C. I built a release-governance agent that runs on a quarterly cadence across four surfaces — backend, API spec, SDK, and runbooks. It classifies every change as additive, breaking, or ambiguous, checks whether the SDK and runbooks were updated to match, and produces a go/no-go report. A human always makes the final call."

## The 7 planted changes (your demo script)
| # | Change | Classification | Why it matters |
|---|--------|---------------|----------------|
| 1 | sort_order added to /list-records | ADDITIVE ✅ | Everything updated correctly — shows system confirms good changes too |
| 2 | New /analytics endpoint | ADDITIVE ⚠️ | SDK and runbook missing — catches documentation debt |
| 3 | user_id renamed to account_id | BREAKING 🔴 | Nothing updated — silent customer breakage |
| 4 | region removed from /create-record | BREAKING 🔴 | SDK updated but runbook missing — partial gap |
| 5 | timeout default null → 30000ms | AMBIGUOUS 🔴 | Contract unchanged but behavior changed — linter would miss this |
| 6 | /search now returns fuzzy matches | AMBIGUOUS 🔴 | Contract unchanged but results different — best demo moment |
| 7 | api_version header now required | BREAKING 🔴 | Nothing updated — breaks every existing customer |

## Your best line in the demo (say this when showing change 5 or 6)
"This is why you need an intelligent agent, not a linter. The API contract looks identical — but the behavior changed underneath. A diff tool would miss this entirely."

## Key design decisions (when they ask why you built it this way)
- **Why 4 subagents?** Each stage needs different reasoning depth. Judge gets the strongest model, others run cheaper. Real engineering judgment, not just wiring things together.
- **Why quarterly not per-commit?** Catches what accumulates over time — different problem than a linter or CI bot.
- **Why bias toward false positives?** False alarm = 5 mins of review. Missed breaking change = customer outage. Cost asymmetry is massive.
- **Why draft fixes but never apply them?** Enterprises don't hand AI full autonomy on day one. Trust is earned incrementally.
- **Why Cursor SDK?** Native subagent orchestration, full harness, same runtime as the IDE. Could be triggered from CI pipeline or a webhook.

## Known limitations (say these BEFORE they ask)
- Single repo only — multi-repo SDK generation not handled yet
- No cross-service breaking changes
- Drafted fixes are first drafts, not production-ready

## Live extension options (if they ask you to extend it)
- "Add deprecated classification" → fourth bucket in Judge, 5 min live
- "Handle separate SDK repo" → point Watcher at two repos
- "Add severity levels" → breaking-critical vs breaking-minor
