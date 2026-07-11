# chat-kit — architecture

Same design rules as every kit in this family: **pure core + storage seams +
structural adapters**. The kit never owns tables, never imports socket.io or
express, and never imports a sibling kit — it declares parameter interfaces
that sibling kits satisfy by shape (`identity` ← @authkit/core, `notifier` ←
@notifykit/core).

## The model

```
                policy.scopes[type]
                        │
   getOrCreateThread ───┤ loadScope → participants → find-or-create
                        │                            (+ roster re-sync)
   sendMessage ─────────┤ participant? canPost? rate limit
                        ▼
                 messages.create + threads.touch
                        │
        ┌───────────────┴───────────────────┐
        ▼                                   ▼
 realtime.emitToUser                presence.isOnline?
 (every participant,                    miss → notifier.notify
  event name configurable)              ('chat.message_received')
```

### Scope-typed threads
A thread is always `(scopeType, scopeId)` — the conversation is *about*
something. The app declares each type once; the policy answers, from the
app's own domain object:
- `participants(scope)` — the roster (customer+cook for an order,
  customer+staff for a salon pair);
- `canPost` — when the conversation is open (order not cancelled…);
- `canRead` — optional widening (support/admin access).

Deny by default: unknown scope type or missing scope → error; non-participants
can neither read nor post. The roster is re-synced from the policy on every
thread access, so staff changes propagate without app code.

### Groups: a scope with managed membership
Domain scopes get their roster for free (an order knows its parties). User-
created groups don't — so the kit ships `GroupStore` + `createGroupService`:
membership CRUD with owner/admin/member permissions (exactly one owner,
transfer via setRole), membership events as system messages, and the same
roster re-sync making removals take effect on the next call. The thread model
is untouched — a group thread is an ordinary thread.

### Presence-aware delivery
Realtime goes to every participant (multi-tab safe via per-user rooms). Push
goes only to recipients who are offline *right now* — `PresenceLike` is the
seam, and `@chatkit/socketio`'s tracker (socket count per user) implements
it. Without presence, every non-sender recipient is notified — the safe
default for apps without sockets (a web client can start there).

### System messages
`postSystemMessage` writes an authorless message and notifies **all**
participants. This is how order/inquiry status changes land inside the
conversation (e.g. inquiry status updates) without faking a sender.

### Event-name compatibility
Deployed clients keep listening to their existing event names.
Outbound names (`events.messageNew`, `events.threadRead`) and inbound names
(`inbound.send`, `inbound.read`) are config — migration never breaks a
shipped client.

### Delivery is best-effort, persistence is truth
Store failures fail the send. Realtime/notifier failures never do — they're
isolated per recipient/channel and reported through `onError`, mirroring
@notifykit/core. A missed socket event is recovered by the REST history
endpoint on next open.

## Seams

| seam | direction | implemented by |
| --- | --- | --- |
| `ThreadStore` / `MessageStore` | kit → app | Prisma / raw SQL; memory stores are the reference |
| `RealtimeLike` | kit → adapter | `createSocketTransport(io)` (rooms) or anything with `emitToUser` |
| `PresenceLike` | kit → adapter | `createPresenceTracker()` or the app's own presence service |
| `NotifierLike` | kit → app | `@notifykit/core` Notifier fits as-is |
| `IdentityLike` | gateway → app | `@authkit/core` TokenService fits as-is |
| `now()` | test seam | fake clock |

## Wiring order (the only subtlety)

The service needs the transport+presence; the gateway needs the service.
Create presence and transport first, service second, attach the gateway last
— see README. There is no circular dependency, just construction order.

## Deliberately NOT in v1

- **Attachments/media** — upload pipelines are app infrastructure; `data` on
  a message carries whatever reference the app wants.
- **Typing indicators** — pure realtime sugar, no persistence; apps can emit
  them on the same socket without kit involvement.
- **Owner broadcast** (one message to N recipients) — that is a
  fan-out of independent notifications, not a thread concern; it stays on
  notifykit. If a per-customer thread message is ever wanted, it's a loop
  over `sendMessage`.
- **Cross-instance presence/rooms** — single-node is the v1 target; a Redis
  adapter can implement `PresenceLike`/`RealtimeLike` later without touching
  the core.
- **Delete/edit messages** — adding a store method +
  service call later is non-breaking.
