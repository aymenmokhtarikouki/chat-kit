# @chatkit/socketio

Socket.IO glue for @chatkit/core: token-verified handshakes, per-user rooms, a multi-socket presence tracker and the RealtimeLike transport. Structural typing — bring your own socket.io server (v4+ recommended), it is NOT a dependency of this package.

## Install

```bash
npm install @chatkit/socketio
```

Installs with it: `@chatkit/core` (automatic dependency). **You install `socket.io` yourself.**.

## You provide

- **Your Socket.IO server instance**
- `identity` — anything with `verifyAccess(token) → { userId }`; `@authkit/core`'s TokenService fits as-is

The package never owns tables, never imports an ORM, HTTP framework, or
provider SDK it can take as a parameter — storage and delivery are seams your
app implements on its own stack.

## Quick example

```ts
import { attachChatGateway, createPresenceTracker, createSocketTransport } from '@chatkit/socketio'

const presence = createPresenceTracker()
const chat = createChatService({ realtime: createSocketTransport(io), presence, ... })
attachChatGateway({ io, chat, identity: tokenService, presence })
```

## Pairs with

- `@authkit/core` for handshake auth
- event names (both directions) are configurable for deployed clients

Kits pair **by shape, never by import** — pass the sibling kit, your own
service, or a stub in tests.

## Docs

Full contracts and integration guides live in the repo:
https://github.com/aymenmokhtarikouki/chat-kit (`contracts/`, `docs/`).

## License

UNLICENSED — published for use by the author's applications.
