# chat-kit — HTTP contract

The shapes `@chatkit/express` serves and the Flutter/web clients implement.
Envelopes vary per app; the payloads below sit inside the app's envelope.
Realtime delivery is in [EVENTS.md](EVENTS.md) — these REST endpoints cover
history paging, inbox lists and polling fallbacks.

All endpoints require the app's auth middleware (`req.auth.userId` by default).

## Entities

```jsonc
// ChatThread
{
  "id": "thr_1",
  "scopeType": "order",              // app-declared: order | inquiry | salonPair | …
  "scopeId": "order-123",
  "participantIds": ["cust-1", "cook-1"],
  "createdAt": "2026-07-10T12:00:00.000Z",
  "lastMessageAt": "2026-07-10T12:05:00.000Z"   // or null
}

// ChatMessage
{
  "id": "msg_9",
  "threadId": "thr_1",
  "senderId": "cust-1",              // null for SYSTEM messages
  "kind": "USER",                    // USER | SYSTEM
  "text": "Is the couscous ready?",
  "data": { "offerId": "of_3" },     // or null — structured payload/deep link
  "createdAt": "2026-07-10T12:05:00.000Z"
}
```

## Endpoints

### GET /chat/threads — inbox
Query: `limit?` (default 20), `offset?`.
```jsonc
// 200
{ "items": [ { "thread": ChatThread, "unreadCount": 2 } ], "total": 5 }
```
Sorted by last activity, newest first.

### GET /chat/threads/:id/messages — history
Query: `before?` (ISO date — pages backwards), `limit?` (default 50).
`200 → [ChatMessage]` newest first.
Errors: `403 NOT_PARTICIPANT | READ_FORBIDDEN`, `404 THREAD_NOT_FOUND`.

### POST /chat/messages — send
```jsonc
{ "scopeType": "order", "scopeId": "order-123", "text": "hello", "data": null }
```
`201 → ChatMessage`. The thread is created on first message if the policy
allows it.
Errors: `400 INVALID_INPUT | EMPTY_MESSAGE | MESSAGE_TOO_LONG | UNKNOWN_SCOPE_TYPE`,
`403 NOT_PARTICIPANT | POST_FORBIDDEN`, `404 SCOPE_NOT_FOUND`,
`429 RATE_LIMITED` (with `retryAfterMs`).

### POST /chat/threads/:id/read — mark read
`200 → { ok: true }`. Emits a read receipt to the other participants.

### GET /chat/unread — badge total
`200 → { unread: 3 }`.

## Error envelope

```jsonc
{ "error": { "code": "RATE_LIMITED", "message": "You are sending messages too quickly.", "retryAfterMs": 6400 } }
```

## Notifier event (offline recipients, through the app's notifykit templates)

| type | recipients | data |
| --- | --- | --- |
| `chat.message_received` | offline participants (never the sender) | `{ threadId, scopeType, scopeId, messageId, senderId, kind, preview }` |

`scopeType`/`scopeId` are the deep link: the client opens the order/inquiry
conversation directly.
