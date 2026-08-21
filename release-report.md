
> meridian-release-agent@1.0.0 start
> tsx src/index.ts

Meridian Release Agent
Comparing: /Users/rajthakore/Projects/meridian-release-agent/meridian-sim/v1  →  /Users/rajthakore/Projects/meridian-release-agent/meridian-sim/v2

Agent ready (id: agent-03b8dfa0-3163-4f4d-9707-853dd0e7a547)
Running Watcher → Judge → CrossChecker → Reporter...

Run started (id: run-44f2edb4-6b1b-4d1d-9ca8-72f4bf9041ed)

────────────────────────────────────────────────────────────

[status] RUNNING
.......................Starting stage 1: launching the watcher subagent to inventory all changes between meridian-sim v1 and v2.
........Watcher inventory complete. Running stage 2: judge to classify each change.
.....Stage 2 complete. Running stage 3: crossChecker to verify SDK and runbook alignment.
......Stage 3 complete. Running stage 4: reporter to produce the final release-readiness report.
.....# Meridian Release Readiness Report

**Release:** meridian-sim v1 → v2  
**Scope:** backend, OpenAPI spec, SDK, runbooks  
**Report date:** August 21, 2026  
**Prepared by:** Release Governance — Reporter subagent

---

## Executive Summary

Meridian-sim v2 introduces seven semantic backend changes across fourteen tracked items (C1–C14). The backend and OpenAPI spec largely reflect the new v2 contract, but the SDK and runbooks are only partially synchronized. **Default SDK usage and runbook-guided integration against the v2 backend will fail** for most core flows: missing `api_version` header (400), stale `user_id` parameter on profile calls (400), and documentation that promises fields and behaviors the backend no longer provides.

Three additive changes are acceptable in isolation (C1 fully covered; C2 and C9 backend-ready but client-invisible). Six breaking changes are documented in OpenAPI, yet four carry active SDK or runbook gaps. Four ambiguous changes lack explicit product acknowledgment—most critically, search behavior now diverges from published contract without any documented decision.

**Verdict: BLOCKED**

Release should not proceed until breaking-change gaps are closed and ambiguous behavioral changes are either documented with an explicit decision or reverted.

---

## Change Inventory

| ID | Summary | Classification | SDK | Runbook | Gap Status |
|----|---------|----------------|-----|---------|------------|
| C1 | Optional `sort_order` on GET /list-records | ADDITIVE | ✅ | ✅ | No gaps |
| C2 | New GET /analytics endpoint | ADDITIVE | ❌ | ❌ | Gaps — endpoint invisible to integrators |
| C3 | `user_id` → `account_id` on GET /get-profile | BREAKING | ❌ | ❌ | Gaps — all guided calls will 400 |
| C4 | `region` removed from POST /create-record response | BREAKING | ✅ | ❌ | Gaps — runbook promises removed field |
| C5 | 30s default timeout constant (backend-internal) | AMBIGUOUS | N/A | N/A | No client-facing gaps |
| C6 | Search: substring matching vs exact-only contract | AMBIGUOUS | ❌ | ❌ | Gaps — docs contradict backend |
| C7 | Required `api_version` header on all endpoints | BREAKING | ❌ | ❌ | Gaps — all guided requests will 400 |
| C8 | Shared `gate()` enforces `api_version` centrally | BREAKING | N/A | N/A | No gaps (tracked under C7) |
| C9 | Analytics routing and types (backend) | ADDITIVE | N/A | N/A | No gaps (tracked under C2) |
| C10 | OpenAPI base paths `/v1` → `/v2` | BREAKING | ✅ | ✅ | No gaps |
| C11 | OpenAPI documents v2 contract updates | BREAKING | N/A | N/A | No gaps (per-change drift tracked individually) |
| C12 | SDK defaults to `/v2` but partial v2 sync | BREAKING | ❌ | N/A | Gaps — default SDK usage cannot succeed |
| C13 | Runbook URLs on v2, sections still describe v1 | AMBIGUOUS | N/A | ❌ | Gaps — mixed v1/v2 guidance |
| C14 | Cross-artifact integrator drift (7 semantic changes, 2 reflected each) | AMBIGUOUS | ❌ | ❌ | Gaps — systemic documentation failure |

---

## Breaking Changes

### C3 — `user_id` renamed to `account_id` (GET /get-profile)

**Impact:** Query parameter and response field rename breaks all v1 clients using `user_id`.

**Alignment:** OpenAPI updated. SDK and runbook still use `user_id`.

**Gaps:**
- `getProfile()` sends `user_id` query parameter
- `UserProfile` interface still defines `user_id`
- Runbook documents `user_id` as required param and response field
- Runbook error examples reference `user_id`

**Severity:** Every SDK- or runbook-guided `getProfile` call receives **400**.

---

### C4 — `region` removed from POST /create-record response

**Impact:** Clients parsing `region` from create responses will break.

**Alignment:** Backend, OpenAPI, and SDK updated. Runbook stale.

**Gaps:**
- Runbook still states response includes `region`
- Runbook 201 example JSON still shows `"region": "us-east-1"`

**Severity:** Integrators following the runbook will expect a field the API no longer returns.

---

### C7 — Required `api_version` header on all endpoints

**Impact:** All requests without `api_version` return **400**.

**Alignment:** Backend (via C8 `gate()`) and OpenAPI updated. SDK and runbook omit the header entirely.

**Gaps:**
- SDK `request()` sends no `api_version` header
- Runbook auth section documents only `X-API-Key`
- All runbook curl examples omit `api_version`

**Severity:** **All** SDK and runbook-guided requests fail against v2.

---

### C8 — Shared `gate()` centralizes header enforcement

**Impact:** Internal refactor; enforcement is universal across handlers.

**Alignment:** No separate client gaps; fully tracked under C7.

---

### C10 — OpenAPI server base paths move to `/v2`

**Impact:** Clients targeting `/v1` URLs break.

**Alignment:** SDK and runbook updated to v2 base paths. No gaps.

---

### C11 — OpenAPI documents full v2 contract

**Impact:** Spec accurately reflects breaking updates (`api_version`, `account_id`, removed `region`, etc.).

**Alignment:** OpenAPI-only change; per-endpoint drift tracked under C2–C7.

---

### C12 — SDK partially synced to v2

**Impact:** SDK defaults to `/v2` but implements only a subset of v2 semantics.

**Gaps:**
- Applied: C1 (`sort_order`), C4 (region removal)
- Missing: C2 (`analytics()`), C3 (`account_id`), C7 (`api_version`), C6 (search doc/types)

**Severity:** Default SDK usage **cannot succeed** against the v2 backend without manual workarounds.

---

## Additive Changes

### C1 — `sort_order` parameter on GET /list-records ✅

Optional query parameter preserves existing behavior when omitted. Fully documented in OpenAPI, SDK, and runbook. **Ready.**

---

### C2 — New GET /analytics endpoint ⚠️

Adds capability without altering existing routes. Backend and OpenAPI implemented (C9).

**Gaps:**
- No `analytics()` client method in v2 SDK
- No `AnalyticsSummary` interface or return type
- No GET /analytics section, parameters, or example in runbook

**Severity:** New endpoint is **invisible** to SDK and runbook users despite being live in backend.

---

### C9 — Analytics routing and types (backend) ✅

Backend-only support for C2. No separate gaps; client visibility tracked under C2.

---

## Ambiguous Changes

### C5 — 30s default timeout constant

Backend introduces a 30s default timeout with no published contract documentation. Classified ambiguous because long-running v1 clients may see new failures without warning.

**Status:** No SDK/runbook gaps (backend-internal). **Requires explicit product acknowledgment** before release—either document in runbook/OpenAPI or confirm as intentional non-contract behavior.

---

### C6 — Search: substring matching vs exact-only contract

Backend now accepts case-insensitive substring matches; OpenAPI, SDK, and runbook still advertise exact-only matching.

**Gaps:**
- SDK `search()` docstring says exact name match only
- `SearchResponse.match_mode` typed as exact only
- Runbook GET /search states exact matches only

**Status:** **Undocumented behavioral change.** Integrators cannot predict query results. Must be resolved by updating docs to match behavior **or** reverting backend to exact-only matching with an explicit decision recorded.

---

### C13 — Runbook URLs on v2, content still describes v1

Runbook base URLs updated (C10) but endpoint sections reflect v1 parameters, fields, and auth.

**Gaps:** Missing C2 analytics, C3 `account_id`, C4 region removal, C7 `api_version`; still documents C6 exact-only search.

**Status:** **Unacknowledged mixed-version guidance.** Operators following the runbook will misconfigure integrations against v2.

---

### C14 — Systemic cross-artifact drift

Seven semantic backend changes; SDK reflects two (C1, C4) and runbook reflects two (C1, C10).

**Status:** **Unacknowledged integrator drift.** Silent failure mode for any client not reading OpenAPI directly. Blocks release until drift is closed or explicitly waived with a migration plan.

---

## SDK / Runbook Gap Analysis

| Change | SDK Updated | Runbook Updated | Critical Gaps |
|--------|-------------|-----------------|---------------|
| C1 sort_order | ✅ | ✅ | None |
| C2 analytics | ❌ | ❌ | No client method, types, or runbook section |
| C3 account_id | ❌ | ❌ | Stale `user_id` everywhere → **400** |
| C4 region removed | ✅ | ❌ | Runbook still shows `region` in response |
| C6 fuzzy search | ❌ | ❌ | Docs say exact; backend does substring |
| C7 api_version | ❌ | ❌ | No header sent/documented → **400** |
| C10 v2 base paths | ✅ | ✅ | None |

**Summary:** The v2 SDK and runbook create a false impression of v2 readiness. Integrators using either artifact will hit **400 errors** on profile and all authenticated calls, miss the analytics endpoint entirely, and receive incorrect guidance on search semantics and create-record responses.

---

## Recommended Actions Before Release

### P0 — Must fix (blocking)

1. **C7 / C8 — Add `api_version` header everywhere**
   - SDK: send `api_version` on every request in `request()`
   - Runbook: document header in auth section; add to all curl examples

2. **C3 — Rename `user_id` → `account_id`**
   - SDK: update `getProfile()` query param, `UserProfile` interface, and types
   - Runbook: update parameters, response schema, and error examples

3. **C12 — Complete SDK v2 sync**
   - Implement remaining items above plus C2 and C6 before publishing SDK as v2-default

### P1 — Should fix (blocking per governance rules)

4. **C4 — Remove `region` from runbook**
   - Update POST /create-record response description and 201 example JSON

5. **C2 / C9 — Document analytics endpoint**
   - SDK: add `analytics()` method and `AnalyticsSummary` type
   - Runbook: add GET /analytics section with parameters and example

6. **C6 — Resolve search behavior mismatch**
   - **Option A:** Update OpenAPI, SDK docstrings, types, and runbook to describe substring matching
   - **Option B:** Revert backend to exact-only matching
   - Record explicit product decision either way

7. **C13 / C14 — Reconcile runbook to v2 contract**
   - Audit all endpoint sections against OpenAPI v2
   - Remove or flag any remaining v1 references

### P2 — Acknowledge before release

8. **C5 — Document or acknowledge 30s timeout**
   - Add to runbook operational notes or confirm as undocumented internal default with release notes entry

9. **Publish migration guide**
   - Cover: `api_version` header, `account_id` rename, removed `region`, search semantics, new analytics endpoint, base path change

---

## Advisory Note

This report is **advisory**. The Release Governance pipeline has classified artifacts, verified cross-artifact alignment, and applied release rules automatically. **A human release manager must make the final release decision.** If the team chooses to ship despite documented gaps, that waiver should be explicit, recorded, and accompanied by a communicated migration plan and timeline for SDK/runbook remediation.

---

*End of report — meridian-sim v1 → v2 release readiness review*
[status] FINISHED

────────────────────────────────────────────────────────────

Run finished with status: finished

===== FINAL REPORT =====

# Meridian Release Readiness Report

**Release:** meridian-sim v1 → v2  
**Scope:** backend, OpenAPI spec, SDK, runbooks  
**Report date:** August 21, 2026  
**Prepared by:** Release Governance — Reporter subagent

---

## Executive Summary

Meridian-sim v2 introduces seven semantic backend changes across fourteen tracked items (C1–C14). The backend and OpenAPI spec largely reflect the new v2 contract, but the SDK and runbooks are only partially synchronized. **Default SDK usage and runbook-guided integration against the v2 backend will fail** for most core flows: missing `api_version` header (400), stale `user_id` parameter on profile calls (400), and documentation that promises fields and behaviors the backend no longer provides.

Three additive changes are acceptable in isolation (C1 fully covered; C2 and C9 backend-ready but client-invisible). Six breaking changes are documented in OpenAPI, yet four carry active SDK or runbook gaps. Four ambiguous changes lack explicit product acknowledgment—most critically, search behavior now diverges from published contract without any documented decision.

**Verdict: BLOCKED**

Release should not proceed until breaking-change gaps are closed and ambiguous behavioral changes are either documented with an explicit decision or reverted.

---

## Change Inventory

| ID | Summary | Classification | SDK | Runbook | Gap Status |
|----|---------|----------------|-----|---------|------------|
| C1 | Optional `sort_order` on GET /list-records | ADDITIVE | ✅ | ✅ | No gaps |
| C2 | New GET /analytics endpoint | ADDITIVE | ❌ | ❌ | Gaps — endpoint invisible to integrators |
| C3 | `user_id` → `account_id` on GET /get-profile | BREAKING | ❌ | ❌ | Gaps — all guided calls will 400 |
| C4 | `region` removed from POST /create-record response | BREAKING | ✅ | ❌ | Gaps — runbook promises removed field |
| C5 | 30s default timeout constant (backend-internal) | AMBIGUOUS | N/A | N/A | No client-facing gaps |
| C6 | Search: substring matching vs exact-only contract | AMBIGUOUS | ❌ | ❌ | Gaps — docs contradict backend |
| C7 | Required `api_version` header on all endpoints | BREAKING | ❌ | ❌ | Gaps — all guided requests will 400 |
| C8 | Shared `gate()` enforces `api_version` centrally | BREAKING | N/A | N/A | No gaps (tracked under C7) |
| C9 | Analytics routing and types (backend) | ADDITIVE | N/A | N/A | No gaps (tracked under C2) |
| C10 | OpenAPI base paths `/v1` → `/v2` | BREAKING | ✅ | ✅ | No gaps |
| C11 | OpenAPI documents v2 contract updates | BREAKING | N/A | N/A | No gaps (per-change drift tracked individually) |
| C12 | SDK defaults to `/v2` but partial v2 sync | BREAKING | ❌ | N/A | Gaps — default SDK usage cannot succeed |
| C13 | Runbook URLs on v2, sections still describe v1 | AMBIGUOUS | N/A | ❌ | Gaps — mixed v1/v2 guidance |
| C14 | Cross-artifact integrator drift (7 semantic changes, 2 reflected each) | AMBIGUOUS | ❌ | ❌ | Gaps — systemic documentation failure |

---

## Breaking Changes

### C3 — `user_id` renamed to `account_id` (GET /get-profile)

**Impact:** Query parameter and response field rename breaks all v1 clients using `user_id`.

**Alignment:** OpenAPI updated. SDK and runbook still use `user_id`.

**Gaps:**
- `getProfile()` sends `user_id` query parameter
- `UserProfile` interface still defines `user_id`
- Runbook documents `user_id` as required param and response field
- Runbook error examples reference `user_id`

**Severity:** Every SDK- or runbook-guided `getProfile` call receives **400**.

---

### C4 — `region` removed from POST /create-record response

**Impact:** Clients parsing `region` from create responses will break.

**Alignment:** Backend, OpenAPI, and SDK updated. Runbook stale.

**Gaps:**
- Runbook still states response includes `region`
- Runbook 201 example JSON still shows `"region": "us-east-1"`

**Severity:** Integrators following the runbook will expect a field the API no longer returns.

---

### C7 — Required `api_version` header on all endpoints

**Impact:** All requests without `api_version` return **400**.

**Alignment:** Backend (via C8 `gate()`) and OpenAPI updated. SDK and runbook omit the header entirely.

**Gaps:**
- SDK `request()` sends no `api_version` header
- Runbook auth section documents only `X-API-Key`
- All runbook curl examples omit `api_version`

**Severity:** **All** SDK and runbook-guided requests fail against v2.

---

### C8 — Shared `gate()` centralizes header enforcement

**Impact:** Internal refactor; enforcement is universal across handlers.

**Alignment:** No separate client gaps; fully tracked under C7.

---

### C10 — OpenAPI server base paths move to `/v2`

**Impact:** Clients targeting `/v1` URLs break.

**Alignment:** SDK and runbook updated to v2 base paths. No gaps.

---

### C11 — OpenAPI documents full v2 contract

**Impact:** Spec accurately reflects breaking updates (`api_version`, `account_id`, removed `region`, etc.).

**Alignment:** OpenAPI-only change; per-endpoint drift tracked under C2–C7.

---

### C12 — SDK partially synced to v2

**Impact:** SDK defaults to `/v2` but implements only a subset of v2 semantics.

**Gaps:**
- Applied: C1 (`sort_order`), C4 (region removal)
- Missing: C2 (`analytics()`), C3 (`account_id`), C7 (`api_version`), C6 (search doc/types)

**Severity:** Default SDK usage **cannot succeed** against the v2 backend without manual workarounds.

---

## Additive Changes

### C1 — `sort_order` parameter on GET /list-records ✅

Optional query parameter preserves existing behavior when omitted. Fully documented in OpenAPI, SDK, and runbook. **Ready.**

---

### C2 — New GET /analytics endpoint ⚠️

Adds capability without altering existing routes. Backend and OpenAPI implemented (C9).

**Gaps:**
- No `analytics()` client method in v2 SDK
- No `AnalyticsSummary` interface or return type
- No GET /analytics section, parameters, or example in runbook

**Severity:** New endpoint is **invisible** to SDK and runbook users despite being live in backend.

---

### C9 — Analytics routing and types (backend) ✅

Backend-only support for C2. No separate gaps; client visibility tracked under C2.

---

## Ambiguous Changes

### C5 — 30s default timeout constant

Backend introduces a 30s default timeout with no published contract documentation. Classified ambiguous because long-running v1 clients may see new failures without warning.

**Status:** No SDK/runbook gaps (backend-internal). **Requires explicit product acknowledgment** before release—either document in runbook/OpenAPI or confirm as intentional non-contract behavior.

---

### C6 — Search: substring matching vs exact-only contract

Backend now accepts case-insensitive substring matches; OpenAPI, SDK, and runbook still advertise exact-only matching.

**Gaps:**
- SDK `search()` docstring says exact name match only
- `SearchResponse.match_mode` typed as exact only
- Runbook GET /search states exact matches only

**Status:** **Undocumented behavioral change.** Integrators cannot predict query results. Must be resolved by updating docs to match behavior **or** reverting backend to exact-only matching with an explicit decision recorded.

---

### C13 — Runbook URLs on v2, content still describes v1

Runbook base URLs updated (C10) but endpoint sections reflect v1 parameters, fields, and auth.

**Gaps:** Missing C2 analytics, C3 `account_id`, C4 region removal, C7 `api_version`; still documents C6 exact-only search.

**Status:** **Unacknowledged mixed-version guidance.** Operators following the runbook will misconfigure integrations against v2.

---

### C14 — Systemic cross-artifact drift

Seven semantic backend changes; SDK reflects two (C1, C4) and runbook reflects two (C1, C10).

**Status:** **Unacknowledged integrator drift.** Silent failure mode for any client not reading OpenAPI directly. Blocks release until drift is closed or explicitly waived with a migration plan.

---

## SDK / Runbook Gap Analysis

| Change | SDK Updated | Runbook Updated | Critical Gaps |
|--------|-------------|-----------------|---------------|
| C1 sort_order | ✅ | ✅ | None |
| C2 analytics | ❌ | ❌ | No client method, types, or runbook section |
| C3 account_id | ❌ | ❌ | Stale `user_id` everywhere → **400** |
| C4 region removed | ✅ | ❌ | Runbook still shows `region` in response |
| C6 fuzzy search | ❌ | ❌ | Docs say exact; backend does substring |
| C7 api_version | ❌ | ❌ | No header sent/documented → **400** |
| C10 v2 base paths | ✅ | ✅ | None |

**Summary:** The v2 SDK and runbook create a false impression of v2 readiness. Integrators using either artifact will hit **400 errors** on profile and all authenticated calls, miss the analytics endpoint entirely, and receive incorrect guidance on search semantics and create-record responses.

---

## Recommended Actions Before Release

### P0 — Must fix (blocking)

1. **C7 / C8 — Add `api_version` header everywhere**
   - SDK: send `api_version` on every request in `request()`
   - Runbook: document header in auth section; add to all curl examples

2. **C3 — Rename `user_id` → `account_id`**
   - SDK: update `getProfile()` query param, `UserProfile` interface, and types
   - Runbook: update parameters, response schema, and error examples

3. **C12 — Complete SDK v2 sync**
   - Implement remaining items above plus C2 and C6 before publishing SDK as v2-default

### P1 — Should fix (blocking per governance rules)

4. **C4 — Remove `region` from runbook**
   - Update POST /create-record response description and 201 example JSON

5. **C2 / C9 — Document analytics endpoint**
   - SDK: add `analytics()` method and `AnalyticsSummary` type
   - Runbook: add GET /analytics section with parameters and example

6. **C6 — Resolve search behavior mismatch**
   - **Option A:** Update OpenAPI, SDK docstrings, types, and runbook to describe substring matching
   - **Option B:** Revert backend to exact-only matching
   - Record explicit product decision either way

7. **C13 / C14 — Reconcile runbook to v2 contract**
   - Audit all endpoint sections against OpenAPI v2
   - Remove or flag any remaining v1 references

### P2 — Acknowledge before release

8. **C5 — Document or acknowledge 30s timeout**
   - Add to runbook operational notes or confirm as undocumented internal default with release notes entry

9. **Publish migration guide**
   - Cover: `api_version` header, `account_id` rename, removed `region`, search semantics, new analytics endpoint, base path change

---

## Advisory Note

This report is **advisory**. The Release Governance pipeline has classified artifacts, verified cross-artifact alignment, and applied release rules automatically. **A human release manager must make the final release decision.** If the team chooses to ship despite documented gaps, that waiver should be explicit, recorded, and accompanied by a communicated migration plan and timeline for SDK/runbook remediation.

---

*End of report — meridian-sim v1 → v2 release readiness review*
