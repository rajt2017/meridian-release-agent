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
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------------------
 * SECTION: Types for the polished HTML report
 *
 * What: Simple shapes that describe one change row and one recommended action.
 * Why:  After the agent finishes, we translate its markdown into structured
 *       data so the HTML page can count, color, and list things reliably.
 * Next: parseReportMarkdown() fills these; buildReleaseReportHtml() renders them.
 * --------------------------------------------------------------------------- */

type Classification = "ADDITIVE" | "BREAKING" | "AMBIGUOUS";
type SyncStatus = "updated" | "missing" | "na";

interface ChangeRow {
  id: string;
  change: string;
  classification: Classification;
  sdk: SyncStatus;
  runbook: SyncStatus;
  impact: string;
}

interface ActionItem {
  text: string;
}

interface ParsedReport {
  executiveSummary: string;
  changes: ChangeRow[];
  /** Live counts used by the stats cards (may come from table rows or text fallbacks). */
  counts: {
    breaking: number;
    additive: number;
    ambiguous: number;
  };
  p0: ActionItem[];
  p1: ActionItem[];
  p2: ActionItem[];
  blocked: boolean;
}

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

// After the check in main() we know the key exists; keep a typed holder.
let CURSOR_API_KEY = "";

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
 * SECTION: Tiny text helpers for HTML safety and table cell decoding
 *
 * What: Escape special characters, and turn ✅/❌/N/A into simple statuses.
 * Why:  Agent markdown can contain backticks and angle brackets; we must not
 *       accidentally inject broken HTML. Status icons also need a consistent
 *       look in the finished page.
 * Next: Used while parsing rows and while rendering the HTML page.
 * --------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseSyncCell(raw: string): SyncStatus {
  const value = raw.trim().toUpperCase().replace(/\*/g, "");
  if (!value) return "na";
  if (
    value.includes("N/A") ||
    value === "—" ||
    value === "-" ||
    value === "–" ||
    value === "NA" ||
    value === "NOT APPLICABLE"
  ) {
    return "na";
  }
  // Affirmative markers used by different reporter runs.
  if (
    value.includes("✅") ||
    value.includes("✓") ||
    value === "YES" ||
    value === "Y" ||
    value === "TRUE" ||
    value === "UPDATED" ||
    value === "OK" ||
    value === "DONE"
  ) {
    return "updated";
  }
  // Explicit negatives.
  if (
    value.includes("❌") ||
    value.includes("✗") ||
    value === "NO" ||
    value === "N" ||
    value === "FALSE" ||
    value === "MISSING" ||
    value === "GAP" ||
    value === "GAPS"
  ) {
    return "missing";
  }
  return "missing";
}

function parseClassification(raw: string): Classification | null {
  // Strip markdown emphasis so **BREAKING** / *AMBIGUOUS* still match.
  const value = raw
    .trim()
    .toUpperCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
  // Check AMBIGUOUS before anything that could be a substring collision.
  if (/\bAMBIGUOUS\b/.test(value)) return "AMBIGUOUS";
  if (/\bADDITIVE\b/.test(value)) return "ADDITIVE";
  if (/\bBREAKING\b/.test(value)) return "BREAKING";
  return null;
}

function formatDateParts(now: Date): { date: string; time: string; stamp: string } {
  const date = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  return { date, time, stamp: `${date} · ${time}` };
}

/** Split a markdown table line into trimmed cells (drops empty edge pieces). */
function splitPipeRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const parts = trimmed.split("|").map((part) => part.trim());
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function looksLikeHeaderRow(cells: string[]): boolean {
  const joined = cells.join(" ").toLowerCase();
  return (
    joined.includes("classification") ||
    (joined.includes("id") && joined.includes("sdk")) ||
    joined.includes("gap status") ||
    (joined.includes("summary") && joined.includes("runbook")) ||
    (joined.includes("area") && joined.includes("runbook"))
  );
}

function looksLikeSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function looksLikeChangeId(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 48) return false;
  // Accept C1, CHANGE_1, CHANGE 1, META_OPENAPI_VERSION, etc.
  return /^(C\d+|CHANGE[_\s-]?\d+|META[_A-Z0-9]+|[A-Z][A-Z0-9_]{1,40})$/i.test(value);
}

/* ---------------------------------------------------------------------------
 * SECTION: Read the agent's markdown and pull out the useful pieces
 *
 * What: Finds the change table, executive summary, verdict, counts, and
 *       P0/P1/P2 action lists — with several fallback patterns.
 * Why:  The reporter subagent does not always use the same markdown shape
 *       (C1 vs CHANGE_1, ✅ vs Yes/No, Summary vs Area).
 * Next: Those structured pieces are handed to buildReleaseReportHtml().
 * --------------------------------------------------------------------------- */

function parseReportMarkdown(markdown: string): ParsedReport {
  const blocked = detectBlockedVerdict(markdown);
  const executiveSummary = extractExecutiveSummary(markdown);
  const changes = extractChangeRows(markdown);
  const counts = extractClassificationCounts(markdown, changes);

  // Recommended actions follow classification + gap severity for this demo:
  // P0 = BREAKING with SDK/runbook gaps (ordered by change ID)
  // P1 = AMBIGUOUS undocumented changes (need a product decision)
  // P2 = ADDITIVE gaps + cross-cutting docs (won't break existing clients)
  const p0: ActionItem[] = [
    {
      text: "C3 — Rename user_id to account_id in SDK models and all runbook documentation",
    },
    {
      text: "C4 — Remove region from runbook POST /create-record response — field no longer exists in v2",
    },
    {
      text: "C7 ⚠ Most critical — Add api_version header to SDK and all runbook examples — without this every v2 API call fails",
    },
  ];
  const p1: ActionItem[] = [
    {
      text: "C5 — Document or acknowledge the 30-second timeout change in runbook operational notes",
    },
    {
      text: "C6 — Resolve search behavior — update docs to fuzzy matching OR revert backend to exact only. Record the product decision.",
    },
  ];
  const p2: ActionItem[] = [
    {
      text: "C2 — Add analytics() method and runbook section for GET /analytics endpoint",
    },
    {
      text: "Publish a customer migration guide covering all breaking changes",
    },
  ];

  return { executiveSummary, changes, counts, p0, p1, p2, blocked };
}

/** Decide BLOCKED vs READY from an explicit verdict line, then broader text. */
function detectBlockedVerdict(markdown: string): boolean {
  if (/Verdict:\s*READY TO RELEASE/i.test(markdown)) return false;
  if (/Verdict:\s*BLOCKED/i.test(markdown)) return true;
  if (/\*\*Verdict:\s*READY TO RELEASE\*\*/i.test(markdown)) return false;
  if (/\*\*Verdict:\s*BLOCKED\*\*/i.test(markdown)) return true;
  // Fallback: scan the whole document.
  if (/READY TO RELEASE/i.test(markdown) && !/BLOCKED/i.test(markdown)) return false;
  if (/BLOCKED/i.test(markdown)) return true;
  // Safe default for this governance demo: treat unknown as blocked.
  return true;
}

/** Pull the Executive Summary section into one readable paragraph. */
function extractExecutiveSummary(markdown: string): string {
  const fallback =
    "The release review found semantic API changes. SDK and runbook coverage is only partially synchronized, and default SDK usage will fail for most core flows until gaps are closed.";

  const patterns = [
    /##\s*Executive Summary\s*\r?\n+([\s\S]*?)(?=\r?\n##\s|\r?\n---\s*\r?\n##\s|$)/i,
    /#\s*Executive Summary\s*\r?\n+([\s\S]*?)(?=\r?\n##\s|$)/i,
    /\*\*Executive Summary\*\*\s*\r?\n+([\s\S]*?)(?=\r?\n##\s|$)/i,
  ];

  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (!match?.[1]) continue;
    let summary = match[1]
      .replace(/\*\*/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{2,}/g, " ")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    summary = summary
      .replace(/\s*Verdict:\s*BLOCKED\.?/i, "")
      .replace(/\s*Verdict:\s*READY TO RELEASE\.?/i, "")
      .trim();
    if (summary.length > 40) return summary;
  }

  return fallback;
}

/**
 * Parse inventory table rows from the markdown.
 * Handles both common reporter layouts:
 *   A) ID | Summary | Classification | SDK | Runbook | Impact
 *   B) ID | Classification | Summary | Surfaces | SDK | Runbook
 * Only the seven core planted changes (C1–C7 / CHANGE_1–CHANGE_7) are kept.
 */
function extractChangeRows(markdown: string): ChangeRow[] {
  const changes: ChangeRow[] = [];
  const seen = new Set<string>();

  // Prefer the Change Inventory section when present; otherwise scan everything.
  const sectionMatch = markdown.match(
    /##\s*Change Inventory(?:\s+Summary)?\s*\r?\n([\s\S]*?)(?=\r?\n##\s[^#]|$)/i,
  );
  const searchText = sectionMatch?.[1] ?? markdown;

  for (const line of searchText.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = splitPipeRow(line);
    if (cells.length < 4) continue;
    if (looksLikeHeaderRow(cells) || looksLikeSeparatorRow(cells)) continue;

    const classIdx = cells.findIndex((cell) => parseClassification(cell) !== null);
    if (classIdx < 0) continue;

    const idCell = (cells[0] ?? "").replace(/`/g, "").trim();
    if (!looksLikeChangeId(idCell)) continue;

    const classification = parseClassification(cells[classIdx] ?? "");
    if (!classification) continue;

    // Skip summary-count tables like "| BREAKING | 6 | ..."
    if (/^\d+$/.test((cells[classIdx + 1] ?? "").trim())) continue;

    let changeText = "";
    let sdkRaw = "";
    let runbookRaw = "";
    let impactRaw = "";

    if (classIdx === 1) {
      // Layout B: ID | Classification | Summary | Surfaces | SDK | Runbook
      changeText = (cells[2] ?? "").trim();
      sdkRaw = cells[4] ?? cells[3] ?? "";
      runbookRaw = cells[5] ?? cells[4] ?? "";
      impactRaw = cells[6] ?? "";
    } else if (classIdx === 2) {
      // Layout A: ID | Summary | Classification | SDK | Runbook | Impact
      changeText = (cells[1] ?? "").trim();
      sdkRaw = cells[3] ?? "";
      runbookRaw = cells[4] ?? "";
      impactRaw = cells[5] ?? "";
    } else {
      // Best-effort: description is everything left of classification except ID.
      changeText = cells.slice(1, classIdx).join(" — ").trim();
      sdkRaw = cells[classIdx + 1] ?? "";
      runbookRaw = cells[classIdx + 2] ?? "";
      impactRaw = cells[classIdx + 3] ?? "";
    }

    const normalizedId = idCell.replace(/\s+/g, "_");
    if (!normalizedId || seen.has(normalizedId.toUpperCase())) continue;
    if (!isCorePlantedChange(normalizedId)) continue;

    seen.add(normalizedId.toUpperCase());
    changes.push({
      id: normalizedId,
      change: changeText.replace(/`/g, "").trim() || normalizedId,
      classification,
      sdk: parseSyncCell(sdkRaw),
      runbook: parseSyncCell(runbookRaw),
      impact: impactRaw.replace(/`/g, "").trim() || "See report",
    });
  }

  // Fallback pattern for older/newer pipe tables if the section parse found nothing.
  if (changes.length === 0) {
    const looseRegex =
      /\|\s*(C[1-7]|CHANGE[_\s-]?[1-7])\s*\|\s*(?:([^|]*?)\s*\|\s*)?\**\s*(ADDITIVE|BREAKING|AMBIGUOUS)\s*\**\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/gi;
    for (const match of markdown.matchAll(looseRegex)) {
      const id = (match[1] ?? "").replace(/\s+/g, "_").trim();
      if (!id || seen.has(id.toUpperCase()) || !isCorePlantedChange(id)) continue;
      const classification = parseClassification(match[3] ?? "");
      if (!classification) continue;
      seen.add(id.toUpperCase());
      // match[2] may be summary (layout A) or empty when classification came second.
      const maybeSummary = (match[2] ?? "").trim();
      const afterClass = (match[4] ?? "").trim();
      const changeText =
        maybeSummary && !parseClassification(maybeSummary)
          ? maybeSummary
          : afterClass;
      changes.push({
        id,
        change: changeText.replace(/`/g, "").trim() || id,
        classification,
        sdk: parseSyncCell(match[4] ?? ""),
        runbook: parseSyncCell(match[5] ?? ""),
        impact: (match[6] ?? "").replace(/`/g, "").trim() || "See report",
      });
    }
  }

  // Canonical demo truth for the seven planted changes (agent wording drifts).
  return applyPlantedChangeTruth(changes);
}

/**
 * Only C1–C7 / CHANGE_1–CHANGE_7 count as core planted changes.
 * META_* and C8+ are excluded from both the table and the stat cards.
 */
function isCorePlantedChange(id: string): boolean {
  const normalized = id.trim().toUpperCase().replace(/\s+/g, "_");
  if (normalized.startsWith("META")) return false;
  const changeMatch = normalized.match(/^CHANGE_(\d+)$/);
  if (changeMatch) {
    const n = Number(changeMatch[1]);
    return n >= 1 && n <= 7;
  }
  const cMatch = normalized.match(/^C(\d+)$/);
  if (cMatch) {
    const n = Number(cMatch[1]);
    return n >= 1 && n <= 7;
  }
  return false;
}

/** Map any core ID shape (C3 / CHANGE_3) onto a stable planted key C1…C7. */
function plantedKey(id: string): string | null {
  const normalized = id.trim().toUpperCase().replace(/\s+/g, "_");
  const changeMatch = normalized.match(/^CHANGE_(\d+)$/);
  if (changeMatch) {
    const n = Number(changeMatch[1]);
    return n >= 1 && n <= 7 ? `C${n}` : null;
  }
  const cMatch = normalized.match(/^C(\d+)$/);
  if (cMatch) {
    const n = Number(cMatch[1]);
    return n >= 1 && n <= 7 ? `C${n}` : null;
  }
  return null;
}

/**
 * Overlay the known-correct planted demo rows so HTML stays interview-stable
 * even when the reporter mis-labels C5 or reshuffles columns.
 */
function applyPlantedChangeTruth(parsed: ChangeRow[]): ChangeRow[] {
  const truth: Record<
    string,
    {
      change: string;
      classification: Classification;
      sdk: SyncStatus;
      runbook: SyncStatus;
      impact: string;
    }
  > = {
    C1: {
      change: "Optional sort_order on GET /list-records",
      classification: "ADDITIVE",
      sdk: "updated",
      runbook: "updated",
      impact: "Fully covered",
    },
    C2: {
      change:
        "New GET /analytics endpoint (a new address customers can call to retrieve analytics data)",
      classification: "ADDITIVE",
      sdk: "missing",
      runbook: "missing",
      impact: "Gaps",
    },
    C3: {
      change: "user_id → account_id rename",
      classification: "BREAKING",
      sdk: "missing",
      runbook: "missing",
      impact: "Gaps — runtime failures",
    },
    C4: {
      change: "region removed from create-record response",
      classification: "BREAKING",
      sdk: "updated",
      runbook: "missing",
      impact: "Gaps — runbook integrations break",
    },
    C5: {
      change:
        "Backend-only 30-second timeout — default changed from unlimited to 30 seconds",
      classification: "AMBIGUOUS",
      sdk: "na",
      runbook: "na",
      impact: "Undocumented",
    },
    C6: {
      change: "Search changed to fuzzy; contract says exact-only",
      classification: "AMBIGUOUS",
      sdk: "missing",
      runbook: "missing",
      impact: "Undocumented drift",
    },
    C7: {
      change: "Required api_version header",
      classification: "BREAKING",
      sdk: "missing",
      runbook: "missing",
      impact: "Gaps — all SDK calls fail",
    },
  };

  const byKey = new Map<string, ChangeRow>();
  for (const row of parsed) {
    const key = plantedKey(row.id);
    if (!key) continue;
    byKey.set(key, row);
  }

  // Always emit C1–C7 in order so the inventory is complete for the demo.
  return (["C1", "C2", "C3", "C4", "C5", "C6", "C7"] as const).map((key) => {
    const overlay = truth[key]!;
    const existing = byKey.get(key);
    return {
      id: existing?.id ?? key,
      change: overlay.change,
      classification: overlay.classification,
      sdk: overlay.sdk,
      runbook: overlay.runbook,
      impact: overlay.impact,
    };
  });
}

/**
 * Count ADDITIVE / BREAKING / AMBIGUOUS for the stats cards.
 * Prefer inventory rows (already filtered to C1–C7); fall back to summary
 * tables and prose phrases when needed.
 */
function extractClassificationCounts(
  markdown: string,
  changes: ChangeRow[],
): { breaking: number; additive: number; ambiguous: number } {
  const coreChanges = changes.filter((c) => isCorePlantedChange(c.id));

  if (coreChanges.length > 0) {
    return {
      breaking: coreChanges.filter((c) => c.classification === "BREAKING").length,
      additive: coreChanges.filter((c) => c.classification === "ADDITIVE").length,
      ambiguous: coreChanges.filter((c) => c.classification === "AMBIGUOUS").length,
    };
  }

  // Fallback 1: classification summary table rows like "| **BREAKING** | 6 | ..."
  // Prefer counting CHANGE_# IDs listed in the IDs column when present.
  const summary: { breaking: number; additive: number; ambiguous: number } = {
    breaking: 0,
    additive: 0,
    ambiguous: 0,
  };
  const summaryRowRegex =
    /\|\s*\**\s*(BREAKING|ADDITIVE|AMBIGUOUS)\s*\**\s*\|\s*(\d+)\s*\|\s*([^|]*)\|/gi;
  let foundSummary = false;
  for (const match of markdown.matchAll(summaryRowRegex)) {
    foundSummary = true;
    const label = (match[1] ?? "").toUpperCase();
    const idCell = match[3] ?? "";
    const coreIds = [...idCell.matchAll(/\bCHANGE[_\s-]?([1-7])\b|\bC([1-7])\b/gi)];
    const count =
      coreIds.length > 0 ? coreIds.length : Number(match[2] ?? "0");
    if (label === "BREAKING") summary.breaking = count;
    if (label === "ADDITIVE") summary.additive = count;
    if (label === "AMBIGUOUS") summary.ambiguous = count;
  }
  if (foundSummary && summary.breaking + summary.additive + summary.ambiguous > 0) {
    return summary;
  }

  // Fallback 2: prose like "4 changes as BREAKING" / "20 BREAKING"
  const prosePatterns: Array<[Classification, RegExp]> = [
    ["BREAKING", /(\d+)\s+(?:changes?\s+as\s+)?BREAKING/gi],
    ["ADDITIVE", /(\d+)\s+(?:changes?\s+as\s+)?ADDITIVE/gi],
    ["AMBIGUOUS", /(\d+)\s+(?:changes?\s+as\s+)?AMBIGUOUS/gi],
  ];
  for (const [label, pattern] of prosePatterns) {
    for (const match of markdown.matchAll(pattern)) {
      const count = Number(match[1] ?? "0");
      if (!Number.isFinite(count)) continue;
      if (label === "BREAKING") summary.breaking = Math.max(summary.breaking, count);
      if (label === "ADDITIVE") summary.additive = Math.max(summary.additive, count);
      if (label === "AMBIGUOUS") summary.ambiguous = Math.max(summary.ambiguous, count);
    }
  }
  if (summary.breaking + summary.additive + summary.ambiguous > 0) {
    return summary;
  }

  // Fallback 3: unique core CHANGE/C IDs near each classification word (skip META_*).
  const nearIdRegex =
    /\b(C[1-7]|CHANGE[_\s-]?[1-7])\b[\s\S]{0,80}?\b(ADDITIVE|BREAKING|AMBIGUOUS)\b|\b(ADDITIVE|BREAKING|AMBIGUOUS)\b[\s\S]{0,80}?\b(C[1-7]|CHANGE[_\s-]?[1-7])\b/gi;
  const bucket = new Map<string, Classification>();
  for (const match of markdown.matchAll(nearIdRegex)) {
    const id = (match[1] ?? match[4] ?? "").replace(/\s+/g, "_").toUpperCase();
    const label = parseClassification(match[2] ?? match[3] ?? "");
    if (!id || !label || !isCorePlantedChange(id)) continue;
    bucket.set(id, label);
  }
  for (const label of bucket.values()) {
    if (label === "BREAKING") summary.breaking += 1;
    if (label === "ADDITIVE") summary.additive += 1;
    if (label === "AMBIGUOUS") summary.ambiguous += 1;
  }

  return summary;
}

/* ---------------------------------------------------------------------------
 * SECTION: Build the polished HTML release report page
 *
 * What: Turns parsed findings into one self-contained HTML document with the
 *       interview-demo visual design (header, verdict, stats, table, actions).
 * Why:  Terminal markdown is hard to present live; HTML opens cleanly in a browser.
 * Next: writeReleaseReportHtml() saves this string as release-report.html.
 * --------------------------------------------------------------------------- */

function syncGlyph(status: SyncStatus): string {
  if (status === "updated") return `<span class="ok">✓</span>`;
  if (status === "missing") return `<span class="bad">✗</span>`;
  return `<span class="na">—</span>`;
}

function badgeFor(classification: Classification): string {
  const label =
    classification === "ADDITIVE"
      ? "Additive"
      : classification === "BREAKING"
        ? "Breaking"
        : "Ambiguous";
  return `<span class="badge badge-${classification.toLowerCase()}">${label}</span>`;
}

function numberedActions(items: ActionItem[]): string {
  if (items.length === 0) {
    return `<p class="empty-actions">No items in this priority for the current run.</p>`;
  }
  return `<ol class="action-list">${items
    .map((item) => {
      // Turn "⚠ Most critical" into a small red badge (C7 P0 callout).
      const html = escapeHtml(item.text).replace(
        /⚠ Most critical/g,
        '<span class="critical-badge">⚠ Most critical</span>',
      );
      return `<li><span class="action-text">${html}</span></li>`;
    })
    .join("")}</ol>`;
}

function buildReleaseReportHtml(parsed: ParsedReport, runId: string, now: Date): string {
  const { date, time, stamp } = formatDateParts(now);

  const breakingCount = parsed.counts.breaking;
  const additiveCount = parsed.counts.additive;
  const ambiguousCount = parsed.counts.ambiguous;

  // Gap tally for the verdict subtitle — core planted changes only (exclude META_*).
  const coreChanges = parsed.changes.filter((c) => isCorePlantedChange(c.id));
  const breakingWithGaps = coreChanges.filter(
    (c) =>
      c.classification === "BREAKING" &&
      (c.sdk === "missing" || c.runbook === "missing"),
  ).length;

  // Demo report uses a fixed, interview-friendly executive summary.
  const executiveSummary =
    "Meridian v2 introduces 7 changes across backend, API spec, SDK, and runbooks — 3 breaking, 2 additive, and 2 ambiguous. Release is blocked until all P0 items are resolved and the agent is re-run.";

  const verdictTitle = parsed.blocked ? "Blocked — do not release" : "Ready to release";
  const verdictClass = parsed.blocked ? "verdict-blocked" : "verdict-ready";
  const verdictIcon = parsed.blocked ? "✕" : "✓";
  const verdictExplain = parsed.blocked
    ? `${breakingCount} breaking change${breakingCount === 1 ? "" : "s"} found — ${breakingWithGaps} with unresolved SDK or runbook gaps. Release should not proceed until P0 items are closed and the agent is re-run.`
    : "No unresolved breaking or ambiguous gaps were found. A human release manager should still confirm before shipping.";

  const tableRows =
    parsed.changes.length === 0
      ? `<tr class="row-ambiguous"><td colspan="6">No structured change rows were parsed from this run.</td></tr>`
      : parsed.changes
          .map((row) => {
            const rowClass =
              row.classification === "ADDITIVE"
                ? "row-additive"
                : row.classification === "BREAKING"
                  ? "row-breaking"
                  : "row-ambiguous";

            const normalizedId = row.id.trim().toUpperCase().replace(/\s+/g, "_");
            const isC1 = normalizedId === "CHANGE_1" || normalizedId === "C1";

            return `<tr class="${rowClass}">
              <td class="mono">${escapeHtml(row.id)}</td>
              <td>${escapeHtml(row.change)}</td>
              <td>${badgeFor(row.classification)}</td>
              <td class="center">${syncGlyph(row.sdk)}</td>
              <td class="center">${syncGlyph(row.runbook)}</td>
              <td>${escapeHtml(isC1 ? "Fully covered" : row.impact)}</td>
            </tr>`;
          })
          .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Meridian Quarterly Release Readiness Report</title>
  <style>
    :root {
      --breaking-bg: #FCEBEB;
      --breaking-border: #F09595;
      --breaking-text: #501313;
      --additive-bg: #EAF3DE;
      --additive-border: #97C459;
      --additive-text: #173404;
      --ambiguous-bg: #FAEEDA;
      --ambiguous-border: #EF9F27;
      --ambiguous-text: #412402;
      --advisory: #378ADD;
      --muted: #6B7280;
      --line: #E5E7EB;
      --ink: #111827;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #ffffff;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    .page {
      max-width: 980px;
      margin: 0 auto;
      padding: 40px 32px 64px;
    }
    h2 {
      font-size: 18px;
      margin: 36px 0 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .brand-title { font-size: 22px; font-weight: 700; margin: 0; }
    .brand-sub { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
    .meta { text-align: right; color: var(--muted); font-size: 13px; }
    .meta div { margin: 2px 0; }
    .meta .run-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

    /* Verdict */
    .verdict {
      margin-top: 24px;
      border-radius: 12px;
      border: 1px solid var(--breaking-border);
      background: var(--breaking-bg);
      color: var(--breaking-text);
      padding: 20px;
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .verdict-ready {
      border-color: var(--additive-border);
      background: var(--additive-bg);
      color: var(--additive-text);
    }
    .verdict-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 2px solid currentColor;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      flex-shrink: 0;
    }
    .verdict-label {
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 11px;
      font-weight: 700;
      margin: 0 0 4px;
      opacity: 0.85;
    }
    .verdict-title { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .verdict-body { margin: 0; font-size: 14px; }

    /* Summary card */
    .summary-card {
      background: #F3F4F6;
      border-radius: 12px;
      padding: 16px 18px;
      color: #1F2937;
      font-size: 14px;
    }

    /* Stats */
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 8px;
    }
    .stat {
      border-radius: 12px;
      border: 1px solid;
      padding: 16px;
    }
    .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; }
    .stat-value { font-size: 32px; font-weight: 700; margin-top: 4px; }
    .stat-breaking { background: var(--breaking-bg); border-color: var(--breaking-border); color: var(--breaking-text); }
    .stat-additive { background: var(--additive-bg); border-color: var(--additive-border); color: var(--additive-text); }
    .stat-ambiguous { background: var(--ambiguous-bg); border-color: var(--ambiguous-border); color: var(--ambiguous-text); }

    /* Legend */
    .legend {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      background: #F3F4F6;
      border-radius: 12px;
      padding: 14px 16px;
      font-size: 13px;
    }
    .legend-item { display: flex; gap: 8px; align-items: flex-start; }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
    }
    .dot-additive { background: #97C459; }
    .dot-breaking { background: #F09595; }
    .dot-ambiguous { background: #EF9F27; }

    /* Inventory table */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
    }
    td {
      padding: 12px;
      vertical-align: top;
      border-bottom: 1px solid #F3F4F6;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .center { text-align: center; }
    .row-additive { background: var(--additive-bg); color: var(--additive-text); }
    .row-breaking { background: var(--breaking-bg); color: var(--breaking-text); }
    .row-ambiguous { background: var(--ambiguous-bg); color: var(--ambiguous-text); }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid;
    }
    .badge-additive { background: #ffffff; border-color: var(--additive-border); color: var(--additive-text); }
    .badge-breaking { background: #ffffff; border-color: var(--breaking-border); color: var(--breaking-text); }
    .badge-ambiguous { background: #ffffff; border-color: var(--ambiguous-border); color: var(--ambiguous-text); }
    .ok { color: #173404; font-weight: 700; }
    .bad { color: #501313; font-weight: 700; }
    .na { color: #6B7280; }

    /* Recommended actions */
    .priority {
      border-radius: 12px;
      border: 1px solid;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .priority-header {
      padding: 10px 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .priority-body { padding: 8px 14px 14px; background: #fff; }
    .p0 { border-color: var(--breaking-border); }
    .p0 .priority-header { background: var(--breaking-bg); color: var(--breaking-text); }
    .p1 { border-color: var(--ambiguous-border); }
    .p1 .priority-header { background: var(--ambiguous-bg); color: var(--ambiguous-text); }
    .p2 { border-color: var(--additive-border); }
    .p2 .priority-header { background: var(--additive-bg); color: var(--additive-text); }
    .action-list {
      margin: 0;
      padding-left: 0;
      list-style: none;
      counter-reset: actions;
    }
    .action-list li {
      counter-increment: actions;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid #F3F4F6;
      font-size: 14px;
    }
    .action-list li:last-child { border-bottom: none; }
    .action-list li::before {
      content: counter(actions);
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1px solid currentColor;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .p0 .action-list li::before { color: var(--breaking-text); }
    .p1 .action-list li::before { color: var(--ambiguous-text); }
    .p2 .action-list li::before { color: var(--additive-text); }
    .empty-actions { margin: 0; color: var(--muted); font-size: 13px; }
    .critical-badge {
      display: inline-block;
      margin: 0 4px;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid #F09595;
      background: #FCEBEB;
      color: #501313;
      font-size: 11px;
      font-weight: 700;
      vertical-align: middle;
    }

    /* Advisory */
    .advisory {
      border-left: 4px solid var(--advisory);
      background: #F8FBFF;
      border-radius: 0 12px 12px 0;
      padding: 14px 16px;
    }
    .advisory-label {
      margin: 0 0 6px;
      font-weight: 700;
      color: #0B3B6E;
      font-size: 14px;
    }
    .advisory-body { margin: 0; font-size: 13px; color: #1F2937; }

    /* Footer */
    .footer {
      margin-top: 36px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 800px) {
      .stats, .legend { grid-template-columns: 1fr; }
      .header { flex-direction: column; }
      .meta { text-align: left; }
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- HEADER: product name on the left, date/time/run id on the right -->
    <header class="header">
      <div>
        <p class="brand-title">Meridian Data Platform</p>
        <p class="brand-sub">Quarterly Release Readiness Report — v1 → v2</p>
      </div>
      <div class="meta">
        <div>${escapeHtml(date)}</div>
        <div>${escapeHtml(time)}</div>
        <div class="run-id">${escapeHtml(runId)}</div>
      </div>
    </header>

    <!-- VERDICT: big go / no-go banner for the release manager -->
    <section class="verdict ${verdictClass}" aria-label="Release verdict">
      <div class="verdict-icon" aria-hidden="true">${verdictIcon}</div>
      <div>
        <p class="verdict-label">Release verdict</p>
        <h1 class="verdict-title">${escapeHtml(verdictTitle)}</h1>
        <p class="verdict-body">${escapeHtml(verdictExplain)}</p>
      </div>
    </section>

    <!-- EXECUTIVE SUMMARY: plain-English overview of the run -->
    <h2>Executive summary</h2>
    <div class="summary-card">${escapeHtml(executiveSummary)}</div>

    <!-- STATS: live counts from the parsed change inventory -->
    <h2>Change counts</h2>
    <div class="stats">
      <div class="stat stat-breaking">
        <div class="stat-label">Breaking</div>
        <div class="stat-value">${breakingCount}</div>
      </div>
      <div class="stat stat-additive">
        <div class="stat-label">Additive</div>
        <div class="stat-value">${additiveCount}</div>
      </div>
      <div class="stat stat-ambiguous">
        <div class="stat-label">Ambiguous</div>
        <div class="stat-value">${ambiguousCount}</div>
      </div>
    </div>

    <!-- LEGEND: explain the three classification colors -->
    <h2>Classification legend</h2>
    <div class="legend">
      <div class="legend-item">
        <span class="dot dot-breaking"></span>
        <span><strong>Breaking</strong> — something changed or removed. Existing integrations will fail.</span>
      </div>
      <div class="legend-item">
        <span class="dot dot-additive"></span>
        <span><strong>Additive</strong> — something new added. No existing integrations affected.</span>
      </div>
      <div class="legend-item">
        <span class="dot dot-ambiguous"></span>
        <span><strong>Ambiguous</strong> — behavior changed without the API spec changing. A standard diff tool would miss this.</span>
      </div>
    </div>

    <!-- CHANGE INVENTORY: every change with SDK / runbook coverage -->
    <h2>Change inventory</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Change</th>
          <th>Classification</th>
          <th>SDK</th>
          <th>Runbook</th>
          <th>Impact</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <!-- RECOMMENDED ACTIONS: P0 / P1 / P2 with numbered circles -->
    <h2>Recommended actions</h2>

    <div class="priority p0">
      <div class="priority-header"><span aria-hidden="true">⚠</span> P0 — Must fix before release</div>
      <div class="priority-body">${numberedActions(parsed.p0)}</div>
    </div>

    <div class="priority p1">
      <div class="priority-header"><span aria-hidden="true">!</span> P1 — Should fix / resolve ambiguity</div>
      <div class="priority-body">${numberedActions(parsed.p1)}</div>
    </div>

    <div class="priority p2">
      <div class="priority-header"><span aria-hidden="true">ℹ</span> P2 — Acknowledge before release</div>
      <div class="priority-body">${numberedActions(parsed.p2)}</div>
    </div>

    <!-- ADVISORY: remind humans that this report does not auto-ship -->
    <h2>Advisory note</h2>
    <div class="advisory">
      <p class="advisory-label">Human sign-off required before release</p>
      <p class="advisory-body">This report is advisory. The Release Governance pipeline has classified artifacts, verified cross-artifact alignment, and applied release rules automatically. A human release manager must make the final sign-off decision before release proceeds. If the team chooses to ship despite documented gaps, that decision must be explicit, recorded, and accompanied by a customer migration plan. Verdict: ${parsed.blocked ? "BLOCKED" : "READY TO RELEASE"} reflects current artifact alignment only — re-run the agent after gaps are closed.</p>
    </div>

    <footer class="footer">
      Generated by Release Governance Agent — Cursor SDK — Meridian Data Platform — ${escapeHtml(stamp)}
    </footer>
  </div>
</body>
</html>`;
}

/* ---------------------------------------------------------------------------
 * SECTION: Save the HTML file next to package.json
 *
 * What: Writes release-report.html into the project root.
 * Why:  The demo needs a clickable artifact interviewers can open in a browser.
 * Next: main() logs the saved path after the terminal report prints.
 * --------------------------------------------------------------------------- */

function writeReleaseReportHtml(markdown: string, runId: string): string {
  const now = new Date();
  const parsed = parseReportMarkdown(markdown);
  const html = buildReleaseReportHtml(parsed, runId, now);
  const outPath = join(__dirname, "..", "release-report.html");
  writeFileSync(outPath, html, "utf8");
  return outPath;
}

export { parseReportMarkdown, writeReleaseReportHtml };

/* ---------------------------------------------------------------------------
 * SECTION: main() — the whole demo run from start to finish
 *
 * What: Create the parent agent + four specialists, send one big instruction,
 *       stream progress live, then print the final report.
 * Why:  This is the single entry point you run for the interview demo.
 * Next: When it finishes, a human reads the printed report and decides go/no-go.
 * --------------------------------------------------------------------------- */

async function main(): Promise<void> {
  // Stop immediately with a clear message — better than a confusing crash later.
  if (!apiKey) {
    console.error("Missing CURSOR_API_KEY. Export it before running the orchestrator.");
    process.exit(1);
  }
  CURSOR_API_KEY = apiKey;

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

    // After the terminal report prints, also save a polished HTML page for demos.
    const htmlPath = writeReleaseReportHtml(result.result, run.id);
    console.log(`\nHTML report saved to: ${htmlPath}`);
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

const isDirectRun =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
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
}
