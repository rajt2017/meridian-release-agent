/**
 * Meridian Data Platform API — v1 handlers
 *
 * This file is the "brain" of Meridian's API for the Q3 2025 quarterly release.
 * Each function below handles one customer-facing endpoint: it checks who is
 * calling, reads their input, looks up or creates data, and sends back a reply.
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
 * A Meridian user account profile — who they are and which plan they are on.
 */
export interface UserProfile {
  user_id: string;
  email: string;
  display_name: string;
  plan: "free" | "pro" | "enterprise";
}

/**
 * What we return after successfully creating a new record,
 * including which geographic region we stored it in.
 */
export interface CreateRecordResult {
  id: string;
  region: string;
  created_at: string;
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
 * Sample user profiles keyed by user_id.
 * Same idea as RECORDS — stand-in data for the interview demo.
 */
const PROFILES: Record<string, UserProfile> = {
  usr_1001: {
    user_id: "usr_1001",
    email: "alex@acme.io",
    display_name: "Alex Rivera",
    plan: "pro",
  },
  usr_1002: {
    user_id: "usr_1002",
    email: "sam@northwind.dev",
    display_name: "Sam Chen",
    plan: "enterprise",
  },
};

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
 * Checks whether the caller proved their identity.
 * Looks for an API key in the X-API-Key header, or as a Bearer token
 * in the Authorization header. Returns true only if a non-empty key is present.
 */
function requireApiKey(req: MeridianRequest): boolean {
  // Prefer the dedicated X-API-Key header; fall back to Authorization: Bearer …
  const key = req.headers["x-api-key"] ?? req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  return Boolean(key && key.length > 0);
}

/**
 * GET /list-records
 *
 * What it does:
 *   Shows the customer a list of all their data records on Meridian.
 *
 * What it accepts:
 *   An optional "filter" query parameter. If provided, only records whose
 *   status matches that value exactly (for example "active") are returned.
 *   If omitted, every record is returned.
 *
 * What it returns:
 *   A 200 response with an array of records plus a count.
 *
 * Business logic:
 *   Filtering is exact-match on status only — no partial matches.
 *   The caller must present a valid API key.
 */
export function listRecords(req: MeridianRequest): MeridianResponse {
  // Reject callers who did not send an API key
  if (!requireApiKey(req)) return unauthorized();

  const filter = req.query.filter;
  // If a filter was provided, keep only records with that exact status;
  // otherwise return the full catalog.
  const records = filter
    ? RECORDS.filter((r) => r.status === filter)
    : RECORDS;

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
 *   Looks up one Meridian user's profile (email, display name, and plan).
 *
 * What it accepts:
 *   A required "user_id" query parameter identifying which user to fetch.
 *
 * What it returns:
 *   A 200 response with the profile when found.
 *   A 400 if user_id was not provided.
 *   A 404 if no profile exists for that user_id.
 *
 * Business logic:
 *   Profiles are looked up by exact user_id. Missing IDs are treated as
 *   "not found," not as a server error.
 */
export function getProfile(req: MeridianRequest): MeridianResponse {
  if (!requireApiKey(req)) return unauthorized();

  const userId = req.query.user_id;
  // user_id is mandatory — tell the caller clearly if they forgot it
  if (!userId) {
    return {
      status: 400,
      body: { error: "bad_request", message: "user_id is required" },
    };
  }

  const profile = PROFILES[userId];
  // Unknown IDs get a not-found reply rather than an empty profile
  if (!profile) {
    return {
      status: 404,
      body: { error: "not_found", message: `No profile for user_id=${userId}` },
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
 *   A 201 (Created) response with the new record's id, the storage region
 *   where it was placed, and a timestamp.
 *   A 400 if "data" is missing or not an object.
 *
 * Business logic:
 *   Every new record is assigned to region "us-east-1" in this release.
 *   The region is included in the response so customers know where their
 *   data lives. A unique id is generated from the current time.
 */
export function createRecord(req: MeridianRequest): MeridianResponse {
  if (!requireApiKey(req)) return unauthorized();

  const body = req.body as { data?: Record<string, unknown> } | undefined;
  // Refuse the request if the customer did not send a usable data object
  if (!body?.data || typeof body.data !== "object") {
    return {
      status: 400,
      body: { error: "bad_request", message: "data field is required" },
    };
  }

  // Mint a simple unique id and always place the record in us-east-1 (v1 default)
  const result: CreateRecordResult = {
    id: `rec_${String(Date.now()).slice(-6)}`,
    region: "us-east-1",
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
 *   A required "q" query parameter — the exact record name to look for.
 *
 * What it returns:
 *   A 200 response with matching records, a count, and match_mode set to "exact".
 *   A 400 if "q" was not provided.
 *   An empty results list (still 200) when nothing matches — that is not an error.
 *
 * Business logic:
 *   v1 supports exact name matching only. Searching for "customer" will NOT
 *   find "customer-events". Partial and fuzzy search are intentionally out of scope.
 */
export function search(req: MeridianRequest): MeridianResponse {
  if (!requireApiKey(req)) return unauthorized();

  const q = req.query.q;
  if (!q) {
    return {
      status: 400,
      body: { error: "bad_request", message: "q is required" },
    };
  }

  // Strict equality on name — no substring or fuzzy matching in this release
  const matches = RECORDS.filter((r) => r.name === q);

  return {
    status: 200,
    body: {
      results: matches,
      match_mode: "exact",
      count: matches.length,
    },
  };
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
 *   Only the four v1 endpoints are recognized. Anything else is rejected
 *   as "not found" so customers get a clear signal rather than a crash.
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
    default:
      // Unknown path/method — return a clear not-found error
      return {
        status: 404,
        body: { error: "not_found", message: `Unknown route: ${route}` },
      };
  }
}
