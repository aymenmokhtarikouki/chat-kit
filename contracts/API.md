# chat-kit — HTTP contract

The shapes `@aymenkits/chat-express` serves and the Flutter/web clients implement.
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

## Groups (user-created multi-user threads)

A group is a scope like any other — its thread, messages, unread counts and
delivery all use the endpoints above with `scopeType: "group"`,
`scopeId: <groupId>`. These endpoints manage the group itself:

```jsonc
// ChatGroup
{
  "id": "grp_1",
  "name": "Weekend trip",
  "createdBy": "alice",
  "members": [ { "userId": "alice", "role": "owner" },
               { "userId": "bob",   "role": "member" } ],
  "createdAt": "2026-07-11T12:00:00.000Z"
}
```

| endpoint | body | notes |
| --- | --- | --- |
| `POST /chat/groups` | `{ name, memberIds? }` | creator becomes `owner`; 201 → ChatGroup |
| `GET /chat/groups` | — | groups the caller belongs to |
| `GET /chat/groups/:id` | — | members only |
| `POST /chat/groups/:id/members` | `{ memberIds }` | owner/admin; existing members skipped |
| `DELETE /chat/groups/:id/members/:uid` | — | owner removes anyone (not owners); admin removes members |
| `POST /chat/groups/:id/leave` | — | anyone but the owner (transfer first) |
| `PATCH /chat/groups/:id` | `{ name }` | owner/admin |
| `POST /chat/groups/:id/role` | `{ memberId, role }` | owner only; promoting to `owner` transfers (old owner → admin) |

Membership changes appear in the thread as SYSTEM messages whose `data` is
the structured event — render/localize client-side:

```jsonc
{ "type": "group.members_added", "actorId": "alice", "userIds": ["bob"] }
// group.created | group.members_added | group.member_removed |
// group.member_left | group.renamed | group.role_changed
```

### GET /chat/threads/:id/read-states — "seen by"

`200 → [ { "userId": "bob", "readAt": "…" | null } ]` — one entry per
participant; `null` = never opened. Requires a store implementing the
optional `getReadStates`; otherwise `501 NOT_SUPPORTED`.
