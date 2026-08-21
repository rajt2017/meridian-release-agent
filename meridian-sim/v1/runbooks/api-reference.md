# Meridian Data Platform API — Reference (v1)

**Release:** Q3 2025 quarterly  
**Base URL:** `https://api.meridian.example/v1`  
**Auth:** Pass your API key in the `X-API-Key` header on every request.

```bash
curl -H "X-API-Key: $MERIDIAN_API_KEY" \
  "https://api.meridian.example/v1/list-records"
```

SDK clients take `baseUrl` and `apiKey` in the constructor:

```ts
import { MeridianClient } from "@meridian/sdk";

const client = new MeridianClient({
  baseUrl: "https://api.meridian.example/v1",
  apiKey: process.env.MERIDIAN_API_KEY!,
});
```

---

## GET /list-records

Returns all records for the authenticated account.

| Param    | In    | Required | Description                                      |
|----------|-------|----------|--------------------------------------------------|
| `filter` | query | no       | Exact status match (`active` or `archived`)      |

**Example**

```bash
curl -H "X-API-Key: $MERIDIAN_API_KEY" \
  "https://api.meridian.example/v1/list-records?filter=active"
```

**Response `200`**

```json
{
  "records": [
    {
      "id": "rec_001",
      "name": "customer-events",
      "status": "active",
      "created_at": "2025-06-12T14:22:00Z"
    }
  ],
  "count": 1
}
```

---

## GET /get-profile

Fetches a user profile by Meridian `user_id`.

| Param     | In    | Required | Description                |
|-----------|-------|----------|----------------------------|
| `user_id` | query | **yes**  | Meridian user identifier   |

**Example**

```bash
curl -H "X-API-Key: $MERIDIAN_API_KEY" \
  "https://api.meridian.example/v1/get-profile?user_id=usr_1001"
```

**Response `200`**

```json
{
  "user_id": "usr_1001",
  "email": "alex@acme.io",
  "display_name": "Alex Rivera",
  "plan": "pro"
}
```

**Errors**

- `400` — `user_id` missing  
- `404` — no profile for that `user_id`

---

## POST /create-record

Creates a new record. The request body must include a `data` object. The response includes the storage `region` assigned to the record.

| Field  | In   | Required | Description                |
|--------|------|----------|----------------------------|
| `data` | body | **yes**  | Arbitrary record payload   |

**Example**

```bash
curl -X POST \
  -H "X-API-Key: $MERIDIAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data":{"name":"inventory-sync","tags":["ops"]}}' \
  "https://api.meridian.example/v1/create-record"
```

**Response `201`**

```json
{
  "id": "rec_482910",
  "region": "us-east-1",
  "created_at": "2025-08-20T18:00:00.000Z"
}
```

**Errors**

- `400` — `data` field missing or not an object

---

## GET /search

Searches records by name. **v1 returns exact matches only** — partial and fuzzy matching are not supported.

| Param | In    | Required | Description              |
|-------|-------|----------|--------------------------|
| `q`   | query | **yes**  | Exact record name        |

**Example**

```bash
curl -H "X-API-Key: $MERIDIAN_API_KEY" \
  "https://api.meridian.example/v1/search?q=customer-events"
```

**Response `200`**

```json
{
  "results": [
    {
      "id": "rec_001",
      "name": "customer-events",
      "status": "active",
      "created_at": "2025-06-12T14:22:00Z"
    }
  ],
  "match_mode": "exact",
  "count": 1
}
```

**Notes**

- `match_mode` is always `"exact"` in this release.
- Queries that do not match a full record name return an empty `results` array (not an error).

---

## Authentication

All endpoints require a valid API key:

| Header       | Value                          |
|--------------|--------------------------------|
| `X-API-Key`  | Your Meridian API key          |

Missing or empty keys return:

```json
{ "error": "unauthorized", "message": "Valid API key required" }
```

with status `401`.

---

## Error shape

Failed requests use a consistent error body:

```json
{
  "error": "bad_request",
  "message": "user_id is required"
}
```
