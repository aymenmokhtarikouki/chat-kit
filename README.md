# chat-kit

Shared chat toolkit for apps where conversations belong to domain objects (whatever comes
next). Threads are **scope-typed** — a conversation is always *about*
something the app declares: an order, a custom-cake inquiry, a salon↔customer
pair — and the **policy decides who chats with whom**: participants come from
the scope, posting rules are per scope type, deny by default.

```
packages/
  core      @aymenkits/chat-core      thread/message engine + policy + send pipeline (zero deps)
  socketio  @aymenkits/chat-socketio  handshake auth, rooms, presence, transport (structural — no socket.io dep)
  express   @aymenkits/chat-express   REST endpoints (threads, history, send, read, unread)
```

## The send pipeline

```
policy.canPost → rate limit → persist → touch thread
   → realtime emit to every participant          (@aymenkits/chat-socketio rooms)
   → presence miss? → notifier for offline ones  (@aymenkits/notify-core push, deep-link data)
```

## Quick start

```ts
import { createChatService } from '@aymenkits/chat-core'
import { attachChatGateway, createPresenceTracker, createSocketTransport } from '@aymenkits/chat-socketio'

const presence  = createPresenceTracker()
const transport = createSocketTransport(io)

const chat = createChatService({
  stores: { threads: myThreadStore, messages: myMessageStore }, // your schema
  realtime: transport,
  presence,
  notifier,                                  // @aymenkits/notify-core Notifier — fits as-is
  policy: {
    scopes: {
      order: {
        loadScope: (id) => orders.findById(id),
        participants: (o) => [o.customerId, o.cookId],
        canPost: ({ scope }) => scope.status !== 'CANCELLED',
      },
      inquiry: {
        loadScope: (id) => inquiries.findById(id),
        participants: (i) => [i.consumerId, i.cookId],
      },
    },
  },
})

attachChatGateway({ io, chat, identity: tokenService /* @aymenkits/auth-core */, presence })

// Anywhere in the app — status updates land in the conversation:
await chat.postSystemMessage({
  scopeType: 'order', scopeId: order.id,
  text: 'Your order was accepted', data: { orderStatus: 'ACCEPTED' },
})
```

## What the kit decides vs. what you decide

| chat-kit owns | your app owns |
| --- | --- |
| thread get-or-create per scope + roster sync | **who participates** (`participants` from your domain object) |
| participant/posting enforcement, deny by default | **when posting closes** (`canPost` — order cancelled, visit done) |
| unread counts, mark-read, read receipts | storage schema (`ThreadStore`/`MessageStore` on Prisma/pg) |
| realtime fan-out + offline push handoff | notification templates, deep-link routing |
| per-sender rate limiting (10 msg / 10 s default) | attachments/media, moderation of content |
| system messages (no sender, everyone notified) | when to post them (order events, offers) |

## Pairs with (by shape, never by import)

| parameter | satisfied by | contract |
| --- | --- | --- |
| `identity` (socket handshake) | `@aymenkits/auth-core` `TokenService` | `verifyAccess(token) → { userId }` |
| `notifier` | `@aymenkits/notify-core` `Notifier` | `notify(userIds, { type, data })` |
| REST auth | `@aymenkits/auth-express` middleware | handlers read `req.auth.userId` by default |

**Deployed clients keep working:** every inbound and outbound socket event
name is configurable (`events` on the service, `inbound` on the gateway), so
each app maps the kit onto the event names its Flutter/web clients already
listen to.

## Group chat

Groups are first-class: a built-in scope backed by a `GroupStore` seam plus
membership management with owner/admin/member roles.

```ts
import { createGroupService, createMemoryGroupStore, groupScope } from '@aymenkits/chat-core'

const groupStore = createMemoryGroupStore()                 // or your table
const chat = createChatService({
  policy: { scopes: { group: groupScope(groupStore) /* + your domain scopes */ } },
  // …
})
const groups = createGroupService({ store: groupStore, chat })

const g = await groups.createGroup({ creatorId, name: 'Weekend trip', memberIds })
await chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId, text: 'hi all' })
await groups.addMembers({ groupId: g.id, actorId, memberIds: ['dave'] })   // owner/admin
```

Membership changes post SYSTEM messages with structured `data`
(`group.members_added`, …) for client-side i18n; rosters re-sync instantly
(removed members lose access on their next call). Per-participant read
states power "seen by" via `chat.readStates()`. Everything else — delivery,
unread, offline push, rate limiting — already worked for N participants.

## Docs

- [contracts/API.md](contracts/API.md) — REST shapes for Flutter/web clients
- [contracts/EVENTS.md](contracts/EVENTS.md) — socket event payloads (both directions)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — seams and design decisions
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — adopting in an existing app, migration notes

## Development

```bash
npm run setup      # install workspaces + build (CI runs exactly this)
npm test           # vitest
npm run typecheck
```
