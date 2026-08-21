/*
 * =============================================================================
 * Meridian Release Agent — the main "conductor" of the whole demo
 * =============================================================================
 *
 * Think of this file as a project manager that never writes the report itself.
 * Instead it hires four specialists (called subagents), runs them in a fixed
 * order, and prints whatever the last specialist produces.
 *
 * Pipeline (what each stage hands to the next):
 *   1. Watcher      → "here is everything that changed"          (JSON list)
 *   2. Judge        → "here is how risky each change is"         (JSON list)
 *   3. CrossChecker → "here is what docs/SDK still missed"       (JSON gaps)
 *   4. Reporter     → "here is the go / no-go release report"    (markdown)
 *
 * A human always makes the final release call. This program only advises.
 */

// Bring in the Cursor SDK pieces we need:
// - Agent: creates and talks to the AI worker
// - CursorAgentError: a specific "could not even start" failure type
// - ModelSelection: the shape of "which AI brain should we use?"
import { Agent, CursorAgentError } from "@cursor/sdk";
import type { ModelSelection } from "@cursor/sdk";

// Node helpers for building file paths on any computer (Mac, Windows, Linux).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------------------
 * SECTION: Figure out where we are on disk
 *
 * What: Find this file's folder, then point at the meridian-sim demo folder.
 * Why:  The specialists need absolute paths so they open the right fake SaaS
 *       codebase no matter which directory you launch the script from.
 * Next: MERIDIAN_SIM_PATH is pasted into each specialist's instructions.
 * --------------------------------------------------------------------------- */

// This program is an ES module, so Node does not give us __dirname for free.
// We rebuild it from the current file's address on disk.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk one folder up from src/, then into meridian-sim/ (v1 and v2 live there).
const MERIDIAN_SIM_PATH = join(__dirname, "..", "meridian-sim");

/* ---------------------------------------------------------------------------
 * SECTION: Load the secret key that lets us call Cursor
 *
 * What: Read CURSOR_API_KEY from the computer's environment variables.
 * Why:  Without this key, Cursor will refuse to start any AI worker.
 * Next: The key is handed to Agent.create so the orchestrator can run.
 * --------------------------------------------------------------------------- */

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  // Stop immediately with a clear message — better than a confusing crash later.
  console.error("Missing CURSOR_API_KEY. Export it before running the orchestrator.");
  process.exit(1);
}

// After the check above we know the key exists; keep a typed copy for later.
const CURSOR_API_KEY: string = apiKey;

/* ---------------------------------------------------------------------------
 * SECTION: Pick which AI "brain" most specialists should use
 *
 * What: Describe the shared model setting used by most specialists (composer-2.5).
 * Why:  Not every step needs the strongest (and most expensive) model.
 *       Watcher, CrossChecker, and Reporter can use this balanced setting.
 *       The Judge alone gets a stronger model because classification is hard.
 * Next: This object is attached to the parent agent and three of the four
 *       specialists when we create them below.
 * --------------------------------------------------------------------------- */

const balancedAuto: ModelSelection = {
  id: "composer-2.5",
};

/* ---------------------------------------------------------------------------
 * SECTION: main() — the whole demo run from start to finish
 *
 * What: Create the parent agent + four specialists, send one big instruction,
 *       stream progress live, then print the final report.
 * Why:  This is the single entry point you run for the interview demo.
 * Next: When it finishes, a human reads the printed report and decides go/no-go.
 * --------------------------------------------------------------------------- */

async function main(): Promise<void> {
  // Friendly banner so anyone watching the terminal knows what started.
  console.log("Meridian Release Agent");
  console.log(`Comparing: ${MERIDIAN_SIM_PATH}/v1  →  ${MERIDIAN_SIM_PATH}/v2\n`);

  /* -------------------------------------------------------------------------
   * SECTION: Hire the parent agent and define its four specialists
   *
   * What: Agent.create builds one "orchestrator" that knows about four named
   *       helpers (watcher, judge, crossChecker, reporter).
   * Why:  Keeping them as separate specialists makes the demo clear: each
   *       role has one job, one input, and one output.
   * Next: We send the orchestrator a prompt telling it which helper to call
   *       in which order, and to pass each helper's output to the next.
   * ----------------------------------------------------------------------- */

  await using agent = await Agent.create({
    // Prove to Cursor that we are allowed to run agents.
    apiKey: CURSOR_API_KEY,

    // A human-readable name that shows up in Cursor's agent list.
    name: "meridian-release-orchestrator",

    // The parent itself uses the balanced model; it mostly delegates.
    model: balancedAuto,

    // Run on this machine, inside the current project folder.
    local: {
      cwd: process.cwd(),
    },

    // The four specialists. The parent calls them by name when needed.
    agents: {
      /* ---------------------------------------------------------------------
       * SPECIALIST 1 — Watcher ("what changed?")
       *
       * What: Reads v1 and v2 side by side and lists every difference.
       * Why:  You cannot judge risk until you know the full change inventory.
       * Passes to Judge: a JSON list of changes (ids, summaries, evidence).
       * ------------------------------------------------------------------- */
      watcher: {
        description:
          "Diffs meridian-sim/v1 vs meridian-sim/v2 across backend, api-spec, sdk, and runbooks. Use first to inventory every change.",
        model: balancedAuto,
        prompt: `You are the Watcher for Meridian's quarterly release review.

Your only job is to compare the LAST release (v1) with TODAY's codebase (v2) and list every change you find.

Paths (absolute):
- v1 root: ${MERIDIAN_SIM_PATH}/v1
- v2 root: ${MERIDIAN_SIM_PATH}/v2

Read corresponding files under these four surfaces in BOTH versions:
- backend/
- api-spec/
- sdk/
- runbooks/

Produce a JSON array. Each item must include:
- id (stable short id, e.g. "C1")
- surface (backend | api-spec | sdk | runbooks | multiple)
- summary (what changed, in plain English)
- v1_evidence (short quote or description of old behavior)
- v2_evidence (short quote or description of new behavior)
- files (list of relative paths you compared)

Be thorough. Include behavioral changes even when the published API contract text looks identical.
Return ONLY valid JSON — no markdown fences, no commentary.`,
      },

      /* ---------------------------------------------------------------------
       * SPECIALIST 2 — Judge ("how risky is each change?")
       *
       * What: Labels every Watcher item as ADDITIVE, BREAKING, or AMBIGUOUS.
       * Why:  Release managers need a clear risk bucket, not a raw file diff.
       *       Uses the stronger composer-2.5 model because this judgment call
       *       is the hardest part of the pipeline.
       * Passes to CrossChecker: the same list, now with classifications.
       * ------------------------------------------------------------------- */
      judge: {
        description:
          "Classifies each Watcher change as ADDITIVE, BREAKING, or AMBIGUOUS with a one-line reason. Use after Watcher.",
        // Stronger brain on purpose — wrong labels here poison the whole report.
        model: { id: "composer-2.5" },
        prompt: `You are the Judge for Meridian's quarterly release review.

You receive the Watcher's JSON list of changes. For each change, assign exactly one classification:

- ADDITIVE — new optional capability; existing clients keep working
- BREAKING — existing clients will fail or must change (renames, removals, newly required fields/headers)
- AMBIGUOUS — the published contract looks the same (or nearly so) but runtime behavior changed in a way that can surprise clients

For every item output:
- id (same as Watcher)
- classification (ADDITIVE | BREAKING | AMBIGUOUS)
- reason (one plain-English sentence)

Return ONLY valid JSON — an array of those objects. No markdown fences.`,
      },

      /* ---------------------------------------------------------------------
       * SPECIALIST 3 — CrossChecker ("did docs and SDK keep up?")
       *
       * What: For each classified change, checks whether the SDK and runbooks
       *       were updated to match.
       * Why:  A breaking change that is "correct" in code but missing from
       *       docs still breaks customers. This stage finds those gaps.
       * Passes to Reporter: a JSON gap list (what is covered vs missing).
       * ------------------------------------------------------------------- */
      crossChecker: {
        description:
          "Checks whether sdk and runbooks were updated to match each classified change. Produces a gap list. Use after Judge.",
        model: balancedAuto,
        prompt: `You are the CrossChecker for Meridian's quarterly release review.

You receive the Judge's classified change list. For EACH change, inspect the v2 sdk/ and runbooks/ surfaces under:
- ${MERIDIAN_SIM_PATH}/v2/sdk
- ${MERIDIAN_SIM_PATH}/v2/runbooks

Compare against v1 when needed:
- ${MERIDIAN_SIM_PATH}/v1/sdk
- ${MERIDIAN_SIM_PATH}/v1/runbooks

Decide whether documentation/client surfaces were updated to match the backend/api-spec change.

Produce a JSON "gap list". Each item must include:
- id
- classification
- sdk_updated (true | false | not_applicable)
- runbook_updated (true | false | not_applicable)
- gaps (array of plain-English gap descriptions; empty if fully covered)
- severity_note (why this gap matters, or "fully covered")

Return ONLY valid JSON. No markdown fences.`,
      },

      /* ---------------------------------------------------------------------
       * SPECIALIST 4 — Reporter ("write the go / no-go memo")
       *
       * What: Turns the gap list into a clean markdown release report with a
       *       BLOCKED or READY TO RELEASE verdict.
       * Why:  Executives and release managers need a readable memo, not JSON.
       * Passes to the terminal (and the human): the final advisory report.
       * ------------------------------------------------------------------- */
      reporter: {
        description:
          "Turns the gap list into a markdown release-readiness report with a BLOCKED or READY TO RELEASE verdict. Use last.",
        model: balancedAuto,
        prompt: `You are the Reporter for Meridian's quarterly release review.

You receive the CrossChecker's gap list. Write a clean markdown release-readiness report for a human release manager.

Required sections:
1. Title and short executive summary
2. Verdict line that is EXACTLY one of:
   - **Verdict: BLOCKED**
   - **Verdict: READY TO RELEASE**
   Use BLOCKED if any BREAKING change has gaps, or any AMBIGUOUS change is undocumented / unacknowledged. Otherwise READY TO RELEASE.
3. Table or bullet list of every change with classification and gap status
4. "Gaps requiring human action" (or "None")
5. Closing note: a human must make the final call — this report is advisory

Return ONLY the markdown report. No JSON wrapper.`,
      },
    },
  });

  // Confirm the agent hired successfully before we ask it to work.
  console.log(`Agent ready (id: ${agent.agentId})`);
  console.log("Running Watcher → Judge → CrossChecker → Reporter...\n");

  /* -------------------------------------------------------------------------
   * SECTION: The master instruction sent to the parent agent
   *
   * What: One prompt that tells the orchestrator the exact order of work and
   *       reminds it to hand each stage's full output to the next stage.
   * Why:  Without this script, the parent might skip a specialist or invent
   *       answers. The prompt is the job description for the whole pipeline.
   * Next: agent.send(...) starts the run; streaming prints progress live.
   * ----------------------------------------------------------------------- */

  const prompt = `You are Meridian's release-governance orchestrator.

Workspace root: ${process.cwd()}
Meridian simulation root: ${MERIDIAN_SIM_PATH}

Run these four stages IN ORDER. Use the matching named subagent for each stage via the Task / Agent tool. Pass each stage's full output into the next.

1. watcher — Diff ${MERIDIAN_SIM_PATH}/v1 vs ${MERIDIAN_SIM_PATH}/v2 across backend, api-spec, sdk, and runbooks. Produce the JSON change list.
2. judge — Classify every change as ADDITIVE, BREAKING, or AMBIGUOUS with a one-line reason.
3. crossChecker — For each classified change, check whether sdk and runbooks were updated; produce the gap list.
4. reporter — Produce the final markdown release-readiness report with a BLOCKED or READY TO RELEASE verdict.

Rules:
- Do not skip stages.
- Do not invent files; read the meridian-sim tree.
- After the reporter finishes, print the FULL final markdown report as your last message so it appears in the terminal.
- A human always makes the final release decision; your job is the advisory report.`;

  // Hand the master instruction to the agent and get back a "run" handle.
  const run = await agent.send(prompt);
  console.log(`Run started (id: ${run.id})\n`);
  console.log("─".repeat(60));

  /* -------------------------------------------------------------------------
   * SECTION: Stream progress live to the terminal
   *
   * What: As the agent works, print its spoken updates (and light status
   *       dots) so the demo audience can see activity in real time.
   * Why:  Waiting silently for several minutes looks broken. Streaming makes
   *       the pipeline feel alive during the interview.
   * Next: After the stream ends we wait for the official final result.
   * ----------------------------------------------------------------------- */

  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      // Normal prose from the agent — write it straight to the terminal.
      for (const block of event.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        }
      }
    } else if (event.type === "thinking") {
      // Quiet heartbeat so we know it is still working without dumping a novel.
      process.stdout.write(".");
    } else if (event.type === "status") {
      // High-level lifecycle updates like RUNNING or FINISHED.
      process.stdout.write(`\n[status] ${event.status}\n`);
    }
  }

  /* -------------------------------------------------------------------------
   * SECTION: Collect the finished result and show the report
   *
   * What: Wait until the run is fully done, check for failure, then print
   *       the final markdown report one more time in a clear block.
   * Why:  Streaming may interleave progress chatter; this block is the clean
   *       "here is the answer" artifact for the human decision-maker.
   * Next: The program exits. A person reads the report and chooses go / no-go.
   * ----------------------------------------------------------------------- */

  const result = await run.wait();
  console.log("\n" + "─".repeat(60));

  if (result.status === "error") {
    // The run started but failed mid-flight — different from a startup error.
    console.error(`Run failed (id: ${result.id}). Check the transcript for details.`);
    process.exit(2);
  }

  console.log(`\nRun finished with status: ${result.status}`);
  if (result.result) {
    console.log("\n===== FINAL REPORT =====\n");
    console.log(result.result);
  }
}

/* ---------------------------------------------------------------------------
 * SECTION: Start the program and catch early failures
 *
 * What: Call main(), and if Cursor cannot even start (bad key, network, bad
 *       config), print a clear startup error and exit.
 * Why:  Separating "never started" from "started then failed" helps debugging
 *       during the live demo.
 * Next: On success, main() already printed the report. On failure, exit codes
 *       tell scripts/CI what went wrong (1 = startup, 2 = run failure).
 * --------------------------------------------------------------------------- */

main().catch((err: unknown) => {
  if (err instanceof CursorAgentError) {
    console.error(
      `Startup failed: ${err.message} (retryable=${String(err.isRetryable)})`,
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
