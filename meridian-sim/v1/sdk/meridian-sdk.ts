/**
 * Official Meridian TypeScript SDK — v1.0.0
 * Wraps the Meridian Data Platform API (Q3 2025 release).
 */

export interface MeridianClientOptions {
  /** API base URL, e.g. https://api.meridian.example/v1 */
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

export interface CreateRecordResponse {
  id: string;
  region: string;
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

  /** GET /list-records — optionally filter by exact status. */
  async listRecords(filter?: string): Promise<ListRecordsResponse> {
    return this.request<ListRecordsResponse>("GET", "/list-records", {
      query: { filter },
    });
  }

  /** GET /get-profile — fetch a profile by user_id. */
  async getProfile(userId: string): Promise<UserProfile> {
    return this.request<UserProfile>("GET", "/get-profile", {
      query: { user_id: userId },
    });
  }

  /** POST /create-record — create a record; response includes assigned region. */
  async createRecord(data: Record<string, unknown>): Promise<CreateRecordResponse> {
    return this.request<CreateRecordResponse>("POST", "/create-record", {
      body: { data },
    });
  }

  /** GET /search — exact name match only. */
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
