# Meridian Release Agent — Demo Cheat Sheet

## Run the demo (every session)
source ~/.nvm/nvm.sh
export CURSOR_API_KEY=$(grep CURSOR_API_KEY .env | cut -d '=' -f2)
npm start
open release-report.html

## Opening statement (say this first — memorize it)
"I picked Example C. I built a release governance agent using the Cursor SDK that runs on a quarterly cadence. It compares the last release to today across backend, API spec, SDK, and runbooks — classifies every change as additive, breaking, or ambiguous — checks for gaps — and produces a go/no-go report. A human always makes the final call. Let me show you."

## The 7 planted changes
| ID | Change | Classification | SDK | Runbook |
|----|--------|---------------|-----|---------|
| C1 | sort_order added to /list-records | Additive ✅ | ✓ | ✓ |
| C2 | New /analytics endpoint | Additive ⚠️ | ✗ | ✗ |
| C3 | user_id renamed to account_id | Breaking 🔴 | ✗ | ✗ |
| C4 | region removed from /create-record | Breaking 🔴 | ✓ | ✗ |
| C5 | Timeout default → 30 seconds | Ambiguous 🔴 | — | — |
| C6 | Search now returns fuzzy matches | Ambiguous 🔴 | ✗ | ✗ |
| C7 | api_version header now required | Breaking 🔴 | ✗ | ✗ |

## Focus on these three during the demo
C3 — "user_id renamed. Nothing updated. Every customer reading the old field gets nothing back."
C7 — "New required header. SDK doesn't send it. Every single API call returns a 400 error."
C6 — "Search behavior changed. Contract looks identical. A linter misses this. The agent catches it. That's why you need AI, not a diff tool."

## Architecture (say this while npm start is running)
Watcher → finds every change across all 4 surfaces
Judge → classifies: additive, breaking, or ambiguous (uses composer-2.5)
Cross-checker → checks if SDK and runbooks were updated to match
Reporter → writes the go/no-go report and drafts fixes
Human → always makes the final call

## Design decisions (they WILL ask)
Why 4 subagents? Each stage needs different reasoning depth. Judge gets strongest model. Others run cheaper.
Why quarterly? Catches what accumulates over time. Not what a linter catches per commit.
Why false positive bias? False alarm = 5 min review. Missed break = customer outage. Easy choice.
Why never auto-ship? Enterprises don't hand AI full autonomy on day one. Trust is earned.
Why Cursor SDK? Native subagent orchestration. Same runtime as the IDE. Could trigger from CI pipeline.

## Limitations (say these BEFORE they ask)
- Single repo only — multi-repo not handled yet
- No cross-service breaking changes
- Drafted fixes are first drafts — human reviews and applies

## Live extension options
"Add deprecated classification" → fourth bucket in Judge prompt, 5 min live
"SDK in separate repo" → point Watcher at two repos, same pipeline
"Add severity levels" → breaking-critical vs breaking-minor in Judge output

## If something breaks
npm start fails → run: source ~/.nvm/nvm.sh then retry
Agent times out → open release-report.html and say "let me show you my last run"
Stumped on a question → say "let me think through that out loud" and reason using the rulebook

## Closing line
"AI made coding fast. That moved the bottleneck downstream to release governance. Everyone's solving the review problem. I went one step further — to the quarterly release moment where accumulated drift becomes a real customer risk. This agent is the start of that answer."
