/**
 * Meridian Data Platform API — v2 handlers
 *
 * This file is the "brain" of Meridian's API as of TODAY (post Q3 2025 release).
 * Several changes landed since v1 — some documented, some not. The numbered
 * CHANGE blocks below are interview talking points for each planted drift.
 */

/**
 * Shape of an incoming HTTP request that Meridian understands.
 * Think of this as the envelope: how they called us, what they asked for,
 * and any credentials they sent along.
 */
export interface MeridianRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Shape of the reply Meridian sends back.
 * status is the HTTP code (200 = OK, 400 = bad input, etc.);
 * body is the actual payload the customer receives as JSON.
 */
export interface MeridianResponse {
  status: number;
  body: unknown;
}

/**
 * A single data record stored on the platform
 * (for example: a named dataset like "customer-events").
 */
export interface RecordItem {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

/**
 * A Meridian account profile — who they are and which plan they are on.
 */
export interface UserProfile {
  account_id: string;
  email: string;
  display_name: string;
  plan: "free" | "pro" | "enterprise";
}

/**
 * What we return after successfully creating a new record.
 */
export interface CreateRecordResult {
  id: string;
  created_at: string;
}

/**
 * Usage analytics summary returned by GET /analytics.
 */
export interface AnalyticsSummary {
  total_records: number;
  active_records: number;
  requests_last_24h: number;
}

/**
 * Sample records used for this demo.
 * In production these would live in a real database; here they are
 * hard-coded so the API can run without external infrastructure.
 */
const RECORDS: RecordItem[] = [
  { id: "rec_001", name: "customer-events", status: "active", created_at: "2025-06-12T14:22:00Z" },
  { id: "rec_002", name: "billing-ledger", status: "active", created_at: "2025-07-01T09:10:00Z" },
  { id: "rec_003", name: "audit-trail", status: "archived", created_at: "2025-05-20T18:45:00Z" },
];

/**
 * Sample account profiles keyed by account_id.
 */
const PROFILES: Record<string, UserProfile> = {
  usr_1001: {
    account_id: "usr_1001",
    email: "alex@acme.io",
    display_name: "Alex Rivera",
    plan: "pro",
  },
  usr_1002: {
    account_id: "usr_1002",
    email: "sam@northwind.dev",
    display_name: "Sam Chen",
    plan: "enterprise",
  },
};

// ============================================
// CHANGE [5]: [AMBIGUOUS] — timeout default changed from null to 30000ms (nothing updated, contract looks identical)
// Demo talking point: Spec diffs won't catch this — the API looks the same on paper, but callers that relied on "no timeout" can suddenly start failing.
// ============================================
const DEFAULT_TIMEOUT_MS: number | null = 30000;

/**
 * Builds the standard "you are not allowed in" response.
 * Used whenever a request arrives without a valid API key.
 */
function unauthorized(): MeridianResponse {
  return {
    status: 401,
    body: { error: "unauthorized", message: "Valid API key required" },
  };
}

/**
 * Builds the standard "bad request" response for a missing api_version header.
 */
function missingApiVersion(): MeridianResponse {
  return {
    status: 400,
    body: { error: "bad_request", message: "api_version header is required" },
  };
}

/**
 * Checks whether the caller proved their identity.
 * Looks for an API key in the X-API-Key header, or as a Bearer token
 * in the Authorization header. Returns true only if a non-empty key is present.
 */
function requireApiKey(req: MeridianRequest): boolean {
  // Prefer the dedicated X-API-Key header; fall back to Authorization: Bearer …
  const key = req.headers["x-api-key"] ?? req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  return Boolean(key && key.length > 0);
}

// ============================================
// CHANGE [7]: [BREAKING] — new required api_version header on all endpoints (nothing updated)
// Demo talking point: Every existing client breaks overnight because the SDK and runbook never learned about this mandatory header.
// ============================================
function requireApiVersion(req: MeridianRequest): boolean {
  const version = req.headers["api_version"];
  return Boolean(version && version.length > 0);
}

/**
 * Shared gate for auth + api_version. Returns an error response if either check fails,
 * or null when the request is allowed to proceed.
 */
function gate(req: MeridianRequest): MeridianResponse | null {
  if (!requireApiKey(req)) return unauthorized();
  if (!requireApiVersion(req)) return missingApiVersion();
  // Effective per-request timeout ceiling (see CHANGE 5 above)
  void DEFAULT_TIMEOUT_MS;
  return null;
}

/**
 * GET /list-records
 *
 * What it does:
 *   Shows the customer a list of all their data records on Meridian.
 *
 * What it accepts:
 *   An optional "filter" query parameter (exact status match).
 *   An optional "sort_order" query parameter ("asc" or "desc" by created_at).
 *
 * What it returns:
 *   A 200 response with an array of records plus a count.
 *
 * Business logic:
 *   Filtering is exact-match on status only — no partial matches.
 *   The caller must present a valid API key and api_version header.
 */
export function listRecords(req: MeridianRequest): MeridianResponse {
  const blocked = gate(req);
  if (blocked) return blocked;

  const filter = req.query.filter;
  // If a filter was provided, keep only records with that exact status;
  // otherwise return the full catalog.
  let records = filter
    ? RECORDS.filter((r) => r.status === filter)
    : [...RECORDS];

  // ============================================
  // CHANGE [1]: [ADDITIVE] — sort_order field added to /list-records (fully documented)
  // Demo talking point: This is the "golden path" change — optional, non-breaking, and correctly reflected in openapi, SDK, and runbook.
  // ============================================
  const sortOrder = req.query.sort_order;
  if (sortOrder === "asc" || sortOrder === "desc") {
    records = [...records].sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }

  return {
    status: 200,
    body: {
      records,
      count: records.length,
    },
  };
}

/**
 * GET /get-profile
 *
 * What it does:
 *   Looks up one Meridian account profile (email, display name, and plan).
 *
 * What it accepts:
 *   A required "account_id" query parameter identifying which account to fetch.
 *
 * What it returns:
 *   A 200 response with the profile when found.
 *   A 400 if account_id was not provided.
 *   A 404 if no profile exists for that account_id.
 *
 * Business logic:
 *   Profiles are looked up by exact account_id. Missing IDs are treated as
 *   "not found," not as a server error.
 */
export function getProfile(req: MeridianRequest): MeridianResponse {
  const blocked = gate(req);
  if (blocked) return blocked;

  // ============================================
  // CHANGE [3]: [BREAKING] — user_id renamed to account_id on /get-profile (nothing updated)
  // Demo talking point: Clients still sending user_id will get hard 400s, and because the SDK and runbook weren't updated, support tickets pile up.
  // ============================================
  const accountId = req.query.account_id;
  // account_id is mandatory — tell the caller clearly if they forgot it
  if (!accountId) {
    return {
      status: 400,
      body: { error: "bad_request", message: "account_id is required" },
    };
  }

  const profile = PROFILES[accountId];
  // Unknown IDs get a not-found reply rather than an empty profile
  if (!profile) {
    return {
      status: 404,
      body: { error: "not_found", message: `No profile for account_id=${accountId}` },
    };
  }

  return { status: 200, body: profile };
}

/**
 * POST /create-record
 *
 * What it does:
 *   Creates a brand-new data record on the Meridian platform.
 *
 * What it accepts:
 *   A JSON body with a required "data" field. "data" is an object holding
 *   whatever payload the customer wants to store (name, tags, etc.).
 *
 * What it returns:
 *   A 201 (Created) response with the new record's id and a timestamp.
 *   A 400 if "data" is missing or not an object.
 *
 * Business logic:
 *   A unique id is generated from the current time.
 *   Region is still assigned internally but is no longer returned.
 */
export function createRecord(req: MeridianRequest): MeridianResponse {
  const blocked = gate(req);
  if (blocked) return blocked;

  const body = req.body as { data?: Record<string, unknown> } | undefined;
  // Refuse the request if the customer did not send a usable data object
  if (!body?.data || typeof body.data !== "object") {
    return {
      status: 400,
      body: { error: "bad_request", message: "data field is required" },
    };
  }

  // ============================================
  // CHANGE [4]: [BREAKING] — region field removed from /create-record response (runbook NOT updated)
  // Demo talking point: Anyone who parsed response.region will crash, and the runbook still promises that field exists.
  // ============================================
  const result: CreateRecordResult = {
    id: `rec_${String(Date.now()).slice(-6)}`,
    created_at: new Date().toISOString(),
  };

  return { status: 201, body: result };
}

/**
 * GET /search
 *
 * What it does:
 *   Finds records whose name matches the customer's search query.
 *
 * What it accepts:
 *   A required "q" query parameter — the search string to look for.
 *
 * What it returns:
 *   A 200 response with matching records, a count, and match_mode.
 *   A 400 if "q" was not provided.
 *   An empty results list (still 200) when nothing matches — that is not an error.
 *
 * Business logic:
 *   Response shape is unchanged from v1, including match_mode: "exact".
 */
export function search(req: MeridianRequest): MeridianResponse {
  const blocked = gate(req);
  if (blocked) return blocked;

  const q = req.query.q;
  if (!q) {
    return {
      status: 400,
      body: { error: "bad_request", message: "q is required" },
    };
  }

  // ============================================
  // CHANGE [6]: [AMBIGUOUS] — /search now returns fuzzy matches (nothing updated, contract looks identical)
  // Demo talking point: OpenAPI still says "exact only," but substring matches slip into results — silent behavior drift that breaks assumptions without a schema change.
  // ============================================
  const qLower = q.toLowerCase();
  const matches = RECORDS.filter(
    (r) => r.name === q || r.name.toLowerCase().includes(qLower),
  );

  return {
    status: 200,
    body: {
      results: matches,
      // Contract still advertises exact-only; value left as "exact" on purpose
      match_mode: "exact",
      count: matches.length,
    },
  };
}

// ============================================
// CHANGE [2]: [ADDITIVE] — new /analytics endpoint added (SDK and runbook NOT updated)
// Demo talking point: The feature shipped in code and the OpenAPI, but customers using only the SDK or runbook will never discover it.
// ============================================
/**
 * GET /analytics
 *
 * What it does:
 *   Returns a lightweight usage summary for the authenticated account.
 *
 * What it accepts:
 *   No query parameters — auth + api_version headers only.
 *
 * What it returns:
 *   A 200 response with total_records, active_records, and requests_last_24h.
 */
export function analytics(req: MeridianRequest): MeridianResponse {
  const blocked = gate(req);
  if (blocked) return blocked;

  const summary: AnalyticsSummary = {
    total_records: RECORDS.length,
    active_records: RECORDS.filter((r) => r.status === "active").length,
    requests_last_24h: 1284,
  };

  return { status: 200, body: summary };
}

/**
 * Request router
 *
 * What it does:
 *   Acts as the front desk — looks at the HTTP method and path, then
 *   hands the request to the matching endpoint handler above.
 *
 * What it accepts:
 *   Any MeridianRequest (method + path + headers + query/body).
 *
 * What it returns:
 *   Whatever the matched handler returns, or a 404 if the route is unknown.
 *
 * Business logic:
 *   Recognizes the four original endpoints plus GET /analytics.
 */
export function handleRequest(req: MeridianRequest): MeridianResponse {
  // Combine method and path into one key, e.g. "GET /list-records"
  const route = `${req.method.toUpperCase()} ${req.path}`;

  switch (route) {
    case "GET /list-records":
      return listRecords(req);
    case "GET /get-profile":
      return getProfile(req);
    case "POST /create-record":
      return createRecord(req);
    case "GET /search":
      return search(req);
    case "GET /analytics":
      return analytics(req);
    default:
      // Unknown path/method — return a clear not-found error
      return {
        status: 404,
        body: { error: "not_found", message: `Unknown route: ${route}` },
      };
  }
}
