/**
 * Official Meridian TypeScript SDK — v2.0.0
 * Wraps the Meridian Data Platform API (current codebase).
 *
 * Intentional gaps vs backend/openapi (for the interview demo):
 * - CHANGE 1 applied: optional sort_order on listRecords
 * - CHANGE 2 missing: no analytics() helper
 * - CHANGE 3 missing: still sends user_id (backend now expects account_id)
 * - CHANGE 4 applied: CreateRecordResponse no longer includes region
 * - CHANGE 7 missing: does not send the required api_version header
 */

export interface MeridianClientOptions {
  /** API base URL, e.g. https://api.meridian.example/v2 */
  baseUrl: string;
  /** API key from the Meridian dashboard */
  apiKey: string;
}

export interface RecordItem {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface ListRecordsResponse {
  records: RecordItem[];
  count: number;
}

export interface UserProfile {
  user_id: string;
  email: string;
  display_name: string;
  plan: "free" | "pro" | "enterprise";
}

/** CHANGE 4: BREAKING — region removed from create-record response */
export interface CreateRecordResponse {
  id: string;
  created_at: string;
}

export interface SearchResponse {
  results: RecordItem[];
  match_mode: "exact";
  count: number;
}

export class MeridianError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MeridianError";
  }
}

export class MeridianClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: MeridianClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        // CHANGE 7 intentionally missing: sdk does not send api_version
      },
    };
    // Only attach a body for write methods — omit the property entirely for GETs
    // (exactOptionalPropertyTypes rejects `body: undefined`).
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), init);

    const payload = await response.json();
    if (!response.ok) {
      throw new MeridianError(
        `Meridian API error (${response.status}) on ${method} ${path}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }

  /**
   * GET /list-records — optionally filter by exact status.
   * CHANGE 1: ADDITIVE (safe) — optional sortOrder maps to sort_order query param.
   */
  async listRecords(
    filter?: string,
    sortOrder?: "asc" | "desc",
  ): Promise<ListRecordsResponse> {
    return this.request<ListRecordsResponse>("GET", "/list-records", {
      query: { filter, sort_order: sortOrder },
    });
  }

  /**
   * GET /get-profile — fetch a profile by user_id.
   * CHANGE 3 not applied here: still sends user_id; backend now expects account_id.
   */
  async getProfile(userId: string): Promise<UserProfile> {
    return this.request<UserProfile>("GET", "/get-profile", {
      query: { user_id: userId },
    });
  }

  /** POST /create-record — create a record (region no longer returned). */
  async createRecord(data: Record<string, unknown>): Promise<CreateRecordResponse> {
    return this.request<CreateRecordResponse>("POST", "/create-record", {
      body: { data },
    });
  }

  /** GET /search — exact name match only (per published contract). */
  async search(q: string): Promise<SearchResponse> {
    return this.request<SearchResponse>("GET", "/search", {
      query: { q },
    });
  }
}

/** Convenience factory. */
export function createClient(baseUrl: string, apiKey: string): MeridianClient {
  return new MeridianClient({ baseUrl, apiKey });
}
