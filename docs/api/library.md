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
- 500: Internal server error
