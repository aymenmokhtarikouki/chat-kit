# @aymenkits/chat-express

Express 4/5 REST endpoints over a ChatService: threads with unread counts, history paging, send, mark read, unread total. Envelope- and auth-agnostic.

## Install

```bash
npm install @aymenkits/chat-express
```

Installs with it: `@aymenkits/chat-core` (automatic dependency).

## You provide

- Your Express router + auth middleware (reads `req.auth.userId` by default)

The package never owns tables, never imports an ORM, HTTP framework, or
provider SDK it can take as a parameter — storage and delivery are seams your
app implements on its own stack.

## Quick example

```ts
import { createChatHandlers } from '@aymenkits/chat-express'

const h = createChatHandlers(chat, { wrapResponse })
router.get('/chat/threads', requireAuth, h.listThreads)
```

## Pairs with

- `@aymenkits/auth-express` middleware upstream
- `@aymenkits/chat-socketio` for the realtime side

Kits pair **by shape, never by import** — pass the sibling kit, your own
service, or a stub in tests.

## Docs

Full contracts and integration guides live in the repo:
https://github.com/aymenmokhtarikouki/chat-kit (`contracts/`, `docs/`).

## License

MIT
