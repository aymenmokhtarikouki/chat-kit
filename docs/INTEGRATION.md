# Integrating chat-kit

## Install

```bash
npm install @chatkit/core
npm install @chatkit/socketio socket.io   # realtime (bring your own io server)
npm install @chatkit/express              # optional REST endpoints
```

## Wiring order (the only subtlety)

```ts
const presence  = createPresenceTracker()
const transport = createSocketTransport(io)
const chat      = createChatService({ stores, realtime: transport, presence, notifier, policy })
attachChatGateway({ io, chat, identity: tokenService, presence })
```

## Declare your scopes

A thread is always about something. One scope entry per domain type:

```ts
policy: {
  scopes: {
    order: {
      loadScope: (id) => orders.findById(id),          // throw YOUR errors freely
      participants: (o) => [o.customerId, o.vendorId],
      canPost: ({ scope }) => scope.status !== 'CANCELLED',
    },
  },
}
```

## Group chat

Register the built-in scope and construct the group service after the chat
service (it posts membership system messages through it):

```ts
const groupStore = createMemoryGroupStore() // or GroupStore on your schema
// … policy: { scopes: { group: groupScope(groupStore) } }
const groups = createGroupService({ store: groupStore, chat })
```

`GroupStore` is five methods over one table (id, name, createdBy, members
JSON/join-table). "Seen by" needs the optional `ThreadStore.getReadStates`.

## Deployed clients keep working

Every event name — outbound (`events.messageNew`, `events.threadRead`) and
inbound (`inbound.send`, `inbound.read`) — is configurable, and
`formatRealtimePayload` reshapes the emitted payload to whatever your
existing clients already parse. Migrating a live chat system never requires a
client release.

## Store notes

- `MessageStore.countOthersSince` defines unread = messages not sent by the
  user after their last-read marker; a per-message read-flag schema can
  implement the same contract by ignoring `since`.
- System messages have `senderId: null`; if your schema requires a sender,
  map null to a designated system/owner user in the store.

## Pairing with sibling kits

Kits pair **by shape, never by import** — every integration point is a
parameter interface a sibling kit satisfies structurally. Pass the real kit,
your own service, or a stub in tests.

- `identity` ← `@authkit/core` TokenService (socket handshake auth).
- `notifier` ← `@notifykit/core` (chat.message_received with deep-link data
  for offline recipients).

## Migrating from an existing implementation

The kits were extracted from production systems, and these rules kept those
migrations safe:

1. **Never rewrite a working flow in one step.** Keep your endpoint URLs,
   response envelopes and (for realtime) socket event names byte-identical;
   swap the implementation underneath, one endpoint at a time.
2. **Data stays put.** The store seams map onto your existing tables — new
   capabilities need at most additive columns, never a data migration.
3. **Delete the superseded code in the same change.** Two implementations of
   the same behavior is how drift starts.
4. Where the kit enforces domain rules through policy hooks, your hooks may
   THROW your app's own error types — the kit re-throws them untouched, so
   your API's error contract survives the swap.
