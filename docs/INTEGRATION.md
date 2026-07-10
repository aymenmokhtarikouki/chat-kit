# Integrating chat-kit

Submodule + `file:` deps, exactly like the other kits:

```bash
git submodule add git@github.com:aymenmokhtarikouki/chat-kit.git vendor/chat-kit
```

```jsonc
// package.json — only declare what you import
"dependencies": {
  "@chatkit/core": "file:vendor/chat-kit/packages/core",
  "@chatkit/socketio": "file:vendor/chat-kit/packages/socketio",
  "@chatkit/express": "file:vendor/chat-kit/packages/express"
}
```

Add `npm --prefix vendor/chat-kit run setup` to your `kits:setup` script; CI
inits the submodule and runs kits:setup BEFORE `npm ci`.

## Full wiring with the sibling kits

```ts
import { createChatService } from '@chatkit/core'
import { attachChatGateway, createPresenceTracker, createSocketTransport } from '@chatkit/socketio'
import { createChatHandlers } from '@chatkit/express'

const presence  = createPresenceTracker()
const transport = createSocketTransport(io)

const chat = createChatService({
  stores: { threads, messages },       // your Prisma/pg stores
  realtime: transport,
  presence,
  notifier,                            // @notifykit/core — offline push
  policy: { scopes: { /* order, inquiry, salonPair, … */ } },
  events: { messageNew: 'new_message' },      // ← your deployed client's names
})

attachChatGateway({
  io, chat, presence,
  identity: tokenService,              // @authkit/core — handshake auth
  inbound: { send: 'send_message', read: 'mark_read' },
})

const h = createChatHandlers(chat, { wrapResponse: createApiResponse })
router.get('/chat/threads', requireAuth, h.listThreads)
// …
```

## yuma mapping (module `chat`)

| today | with the kit |
| --- | --- |
| `getOrCreateThreadForOrder` / `getChatForOrder` | scope type `order` — `participants: (o) => [o.consumerId, o.cookId]` |
| `getChatForInquiry` / `sendMessageForInquiry` | scope type `inquiry` (ChatThread.inquiryId becomes the scopeId) |
| `postInquirySystemMessage` | `postSystemMessage` |
| `chat.gateway.ts` (rooms, rate limit 10/10s, presence check, `notifyNewMessage`) | `attachChatGateway` + the built-in limiter + presence tracker + notifier param |
| `listThreadsForUserService` / unread counts / mark-read | `listThreads` / `unreadCount` / `markRead` |

- `ThreadStore` maps onto the existing `ChatThread` table — `scopeType`/`scopeId`
  generalize the current `orderId`/`inquiryId` columns
  (`scopeId = orderId ?? inquiryId`, additive migration or a view).
- Keep yuma's socket event names via `events`/`inbound` config — the deployed
  Flutter app must not notice (`CHAT_EVENTS` in `realtime/socket.events.ts`
  lists the names to pass).
- yuma already has a presence service — either keep it (`PresenceLike` is one
  method) or switch to the kit tracker.

## lineo mapping (module `messages`)

| today | with the kit |
| --- | --- |
| `getOrCreateConversation` (salon↔customer) | scope type `salonPair` — `participants` from the pair + staff |
| `sendMessage` → `emitNewMessage` + engine `onMessageReceived` | the kit pipeline; pass the engine/notifier as `notifier` |
| `listConversations` / `unreadCount` | `listThreads` / `unreadTotal` |
| `broadcast` (owner → all customers) | **stays app-side** — it's a notification fan-out, not a thread (see ARCHITECTURE) |

- lineo's clients listen to their own event names — pass them via config.
- lineo has no presence tracker today: omit `presence` (all recipients get
  push, current behavior) or adopt the kit tracker for the online-skip.

## Migration rules (same as every kit)

1. **Endpoint-by-endpoint behind identical URLs and identical socket event
   names** — deployed Flutter clients are the hard constraint.
2. Data stays put; stores map to existing tables.
3. Delete the superseded gateway/service code in the same change (no stale code).
4. Clean-state-verify the kit before bumping submodule pointers
   (`rm -rf node_modules packages/*/dist package-lock.json && npm run setup && npm test`).
