# OpenCode API Reference

OpenAPI spec for the OpenCode server (v0.0.3) running inside Daytona sandboxes.

## Key Endpoints

### Events

**`GET /event`** — Subscribe to SSE event stream (used by `client.event.subscribe()`)

Returns `Event` union type. Key event types for message handling:

#### `message.updated`
Fired when a message is created or updated. Contains the full message info with role.

```json
{
  "type": "message.updated",
  "properties": {
    "info": { "id": "msg...", "sessionID": "ses...", "role": "user" | "assistant", ... }
  }
}
```

**Message types:**

- **UserMessage** (`role: "user"`): `{ id, sessionID, role: "user", time: { created }, agent, model: { providerID, modelID } }`
- **AssistantMessage** (`role: "assistant"`): `{ id, sessionID, role: "assistant", time: { created, completed? }, parentID, modelID, providerID, mode, agent, path, cost, tokens, finish? }`

#### `message.part.updated`
Fired when a message part is created or updated. Contains the part and optional delta.

```json
{
  "type": "message.part.updated",
  "properties": {
    "part": { "id", "sessionID", "messageID", "type": "text" | "tool" | ... },
    "delta": "optional incremental text"
  }
}
```

**Part types:**

- **TextPart**: `{ id, sessionID, messageID, type: "text", text, synthetic?, ignored?, time?, metadata? }`
- **ToolPart**: `{ id, sessionID, messageID, type: "tool", callID, tool, state: ToolState, metadata? }`
- **ReasoningPart**: `{ id, sessionID, messageID, type: "reasoning", text, time }`
- **FilePart**: `{ id, sessionID, messageID, type: "file", mime, url, filename?, source? }`
- **StepStartPart**: `{ id, sessionID, messageID, type: "step-start", snapshot? }`
- **StepFinishPart**: `{ id, sessionID, messageID, type: "step-finish", reason, cost, tokens }`
- **AgentPart**: `{ id, sessionID, messageID, type: "agent", name }`
- **SubtaskPart**: `{ id, sessionID, messageID, type: "subtask", prompt, description, agent }`
- **RetryPart**: `{ id, sessionID, messageID, type: "retry", attempt, error, time }`
- **CompactionPart**: `{ id, sessionID, messageID, type: "compaction", auto }`
- **SnapshotPart**: `{ id, sessionID, messageID, type: "snapshot", snapshot }`
- **PatchPart**: `{ id, sessionID, messageID, type: "patch", hash, files }`

**ToolState variants:**

- `ToolStatePending`: `{ status: "pending", input, raw }`
- `ToolStateRunning`: `{ status: "running", input, title?, metadata?, time: { start } }`
- `ToolStateCompleted`: `{ status: "completed", input, output, title, metadata, time: { start, end }, attachments? }`
- `ToolStateError`: `{ status: "error", input, error, metadata, time: { start, end } }`

#### `session.idle`
Fired when a session finishes processing.

```json
{
  "type": "session.idle",
  "properties": { "sessionID": "ses..." }
}
```

#### `session.status`
Session status changes.

```json
{
  "type": "session.status",
  "properties": {
    "sessionID": "ses...",
    "status": { "type": "idle" | "retry" | "busy" }
  }
}
```

#### Other event types
`message.removed`, `message.part.removed`, `session.created`, `session.updated`, `session.deleted`, `session.compacted`, `session.diff`, `session.error`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `todo.updated`, `pty.created`, `pty.updated`, `pty.exited`, `pty.deleted`, `file.edited`, `file.watcher.updated`, `vcs.branch.updated`, `command.executed`, `lsp.updated`, `lsp.client.diagnostics`, `server.connected`, `global.disposed`, `installation.updated`, `installation.update-available`

### Global Events

**`GET /global/event`** — Subscribe to global events (wraps Event in GlobalEvent)

```json
{ "directory": "/path/to/project", "payload": { Event } }
```

The `/event` endpoint returns unwrapped `Event` objects directly. The `/global/event` endpoint wraps them in `GlobalEvent` with a `directory` field.

### Sessions

**`POST /session`** — Create session
```json
Request: { "parentID?": "ses...", "title?": "string", "permission?": PermissionRuleset }
Response: Session
```

**`GET /session`** — List sessions (query params: `directory`, `roots`, `start`, `search`, `limit`)

**`GET /session/{sessionID}`** — Get session details

**`DELETE /session/{sessionID}`** — Delete session

**`PATCH /session/{sessionID}`** — Update session (title, archive time)

**`POST /session/{sessionID}/abort`** — Abort active session

### Messages

**`POST /session/{sessionID}/message`** (`session.prompt`) — Send message (synchronous, waits for completion)
```json
Request: {
  "parts": [{ "type": "text", "text": "..." }],
  "model?": { "providerID": "...", "modelID": "..." },
  "agent?": "string",
  "system?": "string"
}
Response: { "info": AssistantMessage, "parts": Part[] }
```

**`POST /session/{sessionID}/prompt_async`** — Send message asynchronously (returns 204 immediately)
Same request body as `session.prompt`.

**`GET /session/{sessionID}/message`** (`session.messages`) — Get all messages in session
```json
Response: [{ "info": Message, "parts": Part[] }]
```

**`GET /session/{sessionID}/message/{messageID}`** — Get specific message

### Health

**`GET /global/health`** — Health check
```json
Response: { "healthy": true, "version": "string" }
```

## Important Notes

- **Every part has `messageID` and `sessionID`** — use `messageID` to correlate parts with their parent message
- **`message.updated` fires for BOTH user and assistant messages** — check `info.role` to distinguish
- **`message.part.updated` parts belong to messages** — the `messageID` field links back to the message whose role you can determine from `message.updated` events
- **TextPart.text is the full accumulated text**, not a delta (though `delta` field exists for incremental updates)
- **The prompt endpoint returns the completed AssistantMessage** — events stream in parallel via SSE while the HTTP response blocks until completion
- **Session IDs match pattern `^ses.*`**, Message IDs match `^msg.*`
