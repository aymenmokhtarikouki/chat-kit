# @chatkit/express

Express 4/5 REST endpoints over a ChatService: threads with unread counts, history paging, send, mark read, unread total. Envelope- and auth-agnostic.

## Install

```bash
npm install @chatkit/express
```

Installs with it: `@chatkit/core` (automatic dependency).

## You provide

- Your Express router + auth middleware (reads `req.auth.userId` by default)

The package never owns tables, never imports an ORM, HTTP framework, or
provider SDK it can take as a parameter — storage and delivery are seams your
app implements on its own stack.

## Quick example

```ts
import { createChatHandlers } from '@chatkit/express'

const h = createChatHandlers(chat, { wrapResponse })
router.get('/chat/threads', requireAuth, h.listThreads)
```

## Pairs with

- `@authkit/express` middleware upstream
- `@chatkit/socketio` for the realtime side

Kits pair **by shape, never by import** — pass the sibling kit, your own
service, or a stub in tests.

## Docs

Full contracts and integration guides live in the repo:
https://github.com/aymenmokhtarikouki/chat-kit (`contracts/`, `docs/`).

## License

UNLICENSED — published for use by the author's applications.
