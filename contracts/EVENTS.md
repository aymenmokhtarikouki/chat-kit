# chat-kit — socket contract

What `@chatkit/socketio` speaks. **Every event name below is a DEFAULT** —
both directions are configurable (`events` on `createChatService`, `inbound`
on `attachChatGateway`) so deployed clients keep their existing names.

## Handshake

```js
io('/…', { auth: { token: '<access token>' } })
```

The gateway verifies the token through the injected identity service
(`@authkit/core` `TokenService.verifyAccess`). Invalid/missing token → the
connection is refused with error message `UNAUTHENTICATED`.

On success the socket joins the user's room (`chat:user:<userId>` by
default) — all deliveries for that user go through it, every tab receives.

## Client → server

### `chat:send` (ack)
```jsonc
// payload
{ "scopeType": "order", "scopeId": "order-123", "text": "hello", "data": null }
// ack — success
{ "ok": true, "data": ChatMessage }
// ack — failure
{ "ok": false, "code": "POST_FORBIDDEN", "message": "Posting is closed for this conversation." }
```
Codes: `INVALID_INPUT`, `UNKNOWN_SCOPE_TYPE`, `SCOPE_NOT_FOUND`,
`NOT_PARTICIPANT`, `POST_FORBIDDEN`, `EMPTY_MESSAGE`, `MESSAGE_TOO_LONG`,
`RATE_LIMITED`, `INTERNAL`.

### `chat:read` (ack)
```jsonc
{ "threadId": "thr_1" }
// ack: { "ok": true } | { "ok": false, "code": "NOT_PARTICIPANT", … }
```

## Server → client

### `chat:new_message`
Sent to EVERY participant's room (including the sender — confirms across tabs).
```jsonc
{
  "threadId": "thr_1",
  "scopeType": "order",
  "scopeId": "order-123",
  "message": ChatMessage
}
```

### `chat:read`
Read receipt, sent to the OTHER participants when someone marks a thread read.
```jsonc
{ "threadId": "thr_1", "userId": "cust-1", "at": "2026-07-10T12:06:00.000Z" }
```

## Offline recipients

Participants without a live socket don't get events — they get a push
notification instead (`chat.message_received` through the app's notifier).
The client's push handler deep-links into the conversation via
`scopeType`/`scopeId` and the REST history endpoint backfills.
