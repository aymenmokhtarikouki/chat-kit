# @aymenkits/chat-core

Scope-typed chat threads (an order, an inquiry, a salon↔customer pair) with a policy deciding who chats with whom; send pipeline: persist → realtime → presence-miss → push notifier. Unread counts, read receipts, system messages, per-sender rate limiting.

## Install

```bash
npm install @aymenkits/chat-core
```

Installs with it: nothing else — zero dependencies.

## You provide

- `ThreadStore` + `MessageStore` — your tables (in-memory reference stores exported)
- `policy.scopes` — YOUR participants/canPost rules per scope type
- Optional `realtime`/`presence` (from `@aymenkits/chat-socketio`) and `notifier`

The package never owns tables, never imports an ORM, HTTP framework, or
provider SDK it can take as a parameter — storage and delivery are seams your
app implements on its own stack.

## Quick example

```ts
import { createChatService } from '@aymenkits/chat-core'

const chat = createChatService({ stores, realtime, presence, notifier,
  policy: { scopes: { order: { loadScope, participants: (o) => [o.customerId, o.cookId],
    canPost: ({ scope }) => scope.status !== 'CANCELLED' } } } })
```

## Pairs with

- `notifier` is satisfied by `@aymenkits/notify-core` as-is
- `@aymenkits/chat-socketio` provides transport + presence
- `@aymenkits/chat-express` for REST

Kits pair **by shape, never by import** — pass the sibling kit, your own
service, or a stub in tests.

## Docs

Full contracts and integration guides live in the repo:
https://github.com/aymenmokhtarikouki/chat-kit (`contracts/`, `docs/`).

## License

MIT
