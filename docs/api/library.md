# Library REST API

All endpoints require authentication via session cookie.

## Scenarios

### List Scenarios
```
GET /api/scenarios?page=1&pageSize=20&search=&favorites=true
```

Response:
```json
{
  "scenarios": [
    {
      "id": "uuid",
      "name": "My Scenario",
      "ownerId": "user-uuid",
      "isFavorite": 0,
      "nodeCount": 5,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "total": 100,
  "page": 1,
  "pageSize": 20
}
```

### Get Scenario
```
GET /api/scenarios/:id
```

Response includes full `graph` object.

### Create Scenario
```
POST /api/scenarios
Content-Type: application/json

{
  "name": "My Scenario",
  "graph": { "nodes": {}, "edges": [] }
}
```

### Update Scenario
```
PUT /api/scenarios/:id
Content-Type: application/json

{
  "name": "New Name",
  "graph": { ... }
}
```

Updates create automatic versions when graph changes.

### Partial Update (favorite, folder)
```
PATCH /api/scenarios/:id
Content-Type: application/json

{
  "isFavorite": 1,
  "folderId": "folder-uuid"
}
```

### Delete Scenario
```
DELETE /api/scenarios/:id
```

## Scenario Versions

### List Versions
```
GET /api/scenarios/:id/versions
```

Response:
```json
{
  "versions": [
    {
      "id": "uuid",
      "version": 1,
      "changeDescription": "Updated graph",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "createdBy": "user-uuid"
    }
  ]
}
```

### Get Version
```
GET /api/scenarios/:id/versions/:versionId
```

Response includes full `graph` snapshot.

## Recordings

### List Recordings
```
GET /api/recordings?page=1&pageSize=20&search=&state=completed
```

States: `recording`, `completed`, `failed`, `processing`

Response:
```json
{
  "recordings": [
    {
      "id": "uuid",
      "name": "Login Flow",
      "startUrl": "https://example.com",
      "state": "completed",
      "durationMs": 45000,
      "requestCount": 23,
      "stepCount": 5,
      "scenarioId": "uuid or null",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "completedAt": "2024-01-01T00:00:45.000Z"
    }
  ],
  "total": 50,
  "page": 1,
  "pageSize": 20
}
```

### Save Recording as Scenario
```
POST /api/recordings
Content-Type: application/json

{
  "name": "My Scenario",
  "startUrl": "https://example.com",
  "entries": [ ... reviewed entries ... ],
  "viewport": { "width": 1280, "height": 720 },
  "recordingId": "uuid"
}
```

## Tags

### List Tags
```
GET /api/tags
```

Response:
```json
{
  "tags": [
    {
      "id": "uuid",
      "name": "Login",
      "color": "#3B82F6",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### Create Tag
```
POST /api/tags
Content-Type: application/json

{
  "name": "Login",
  "color": "#3B82F6"
}
```

### Scenario Tags

```
GET /api/scenarios/:id/tags
POST /api/scenarios/:id/tags { "tagId": "uuid" }
DELETE /api/scenarios/:id/tags?tagId=uuid
```

## Folders

### List Folders
```
GET /api/folders
```

Response:
```json
{
  "folders": [
    {
      "id": "uuid",
      "name": "Production",
      "parentId": null,
      "children": ["child-uuid"],
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "rootFolders": ["uuid"]
}
```

### Create Folder
```
POST /api/folders
Content-Type: application/json

{
  "name": "Production",
  "parentId": null
}
```

## Environments and Variables

Postman-style `{{name}}` variables. Environments (dev/staging/prod) belong to
one user; only that user can read or change them (admins included). Scenario
variables follow the scenario access rule (owner or admin) and override
environment variables with the same name at run time.

**Secrets.** A variable with `secret: true` is never returned in plaintext
after it is saved. Reads return `{ "name", "secret": true, "hasValue" }` with
no `value` field.

### List Environments
```
GET /api/environments
```

Response:
```json
{
  "environments": [
    { "id": "uuid", "name": "staging", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### Create Environment
```
POST /api/environments
Content-Type: application/json

{ "name": "staging" }
```

Returns `201` with the environment. The name is trimmed, 1–100 characters, and
unique per user (`409` on a duplicate).

### Rename Environment
```
PATCH /api/environments/:id
Content-Type: application/json

{ "name": "production" }
```

### Delete Environment
```
DELETE /api/environments/:id
```

Deletes the environment and its variables.

### Get Variables
```
GET /api/environments/:id/variables
GET /api/scenarios/:id/variables
```

Response (sorted by name):
```json
{
  "variables": [
    { "name": "baseUrl", "value": "https://api.example.com", "secret": false },
    { "name": "token", "secret": true, "hasValue": true }
  ]
}
```

### Replace Variables
```
PUT /api/environments/:id/variables
PUT /api/scenarios/:id/variables
Content-Type: application/json

{
  "variables": [
    { "name": "baseUrl", "value": "https://api.example.com", "secret": false },
    { "name": "token", "value": null, "secret": true }
  ]
}
```

The body is the **full set**; any variable left out is deleted. `secret`
defaults to `false`. For a secret, a `null` or missing `value` keeps the stored
value of the variable with the same name, so the client never has to resend a
secret. A non-secret, or a new secret, must send a value. The response has the
same shape as Get Variables.

Rules (`422` on failure):
- name matches `[A-Za-z_][A-Za-z0-9_.-]{0,63}` and is unique in the set (case-sensitive);
- value is at most 8 KiB (UTF-8 bytes);
- at most 200 variables per set;
- no two secrets map to the same k6 env name (`api.key` and `API_KEY` both map to `K6FLOW_VAR_API_KEY`).

`422` body:
```json
{
  "error": "Invalid variables",
  "errors": [
    { "index": 1, "field": "name", "code": "invalid-name", "message": "..." },
    { "index": null, "field": "name", "code": "secret-env-collision", "message": "..." }
  ]
}
```

`index` is the position in the submitted list (`null` for whole-set errors).
Codes: `invalid-shape`, `invalid-name`, `duplicate-name`, `value-too-large`,
`too-many`, `secret-env-collision`, `missing-value`.

### Export and Version History
- `GET /api/scenarios/:id/export?format=json` includes `scenario.variables`.
  Secrets appear as `{ "name", "secret": true }` only, with no value.
- Version snapshots store only the graph, so they hold no variables or secret values.

## Error Responses

All errors return JSON:
```json
{
  "error": "Error message"
}
```

Common status codes:
- 400: Bad request (validation error)
- 401: Unauthorized (no session)
- 403: Forbidden (not owner)
- 404: Not found
- 409: Conflict (duplicate)
- 422: Unprocessable (graph or variable validation; variable errors include `errors`)
- 500: Internal server error
