import { describe, expect, it, vi } from 'vitest'
import {
  createChatService,
  createMemoryMessageStore,
  createMemoryThreadStore,
} from '@aymenkits/chat-core'
import {
  attachChatGateway,
  createPresenceTracker,
  createSocketTransport,
  defaultUserRoom,
  ServerLike,
  SocketLike,
} from '../src/index'

// ─── Fake Socket.IO ──────────────────────────────────────────────────────────

type Middleware = (socket: SocketLike, next: (err?: Error) => void) => void

function fakeServer() {
  const middlewares: Middleware[] = []
  let connectionHandler: ((socket: SocketLike) => void) | null = null
  const roomEmits: Array<{ room: string; event: string; payload: unknown }> = []

  const io: ServerLike = {
    use: (mw) => middlewares.push(mw),
    on: (_event, cb) => {
      connectionHandler = cb
    },
    to: (room) => ({
      emit: (event, payload) => roomEmits.push({ room, event, payload }),
    }),
  }

  function connect(auth: Record<string, unknown>): {
    socket: SocketLike
    handlers: Map<string, (...args: unknown[]) => unknown>
    joined: string[]
    error?: Error
  } {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const joined: string[] = []
    const socket: SocketLike = {
      id: `sock_${Math.random().toString(36).slice(2, 8)}`,
      data: {},
      handshake: { auth },
      join: (room) => void joined.push(room),
      emit: () => undefined,
      on: (event, cb) => handlers.set(event, cb as (...args: unknown[]) => unknown),
    }
    let error: Error | undefined
    for (const mw of middlewares) {
      mw(socket, (err) => {
        if (err) error = err
      })
      if (error) return { socket, handlers, joined, error }
    }
    connectionHandler?.(socket)
    return { socket, handlers, joined }
  }

  return { io, connect, roomEmits }
}

const identity = {
  verifyAccess(token: string) {
    if (token === 'good-token') return { userId: 'cust-1' }
    if (token === 'cook-token') return { userId: 'cook-1' }
    throw new Error('bad token')
  },
}

function buildChat(realtime: { emitToUser: (u: string, e: string, p: unknown) => void }, presence?: { isOnline(id: string): boolean }) {
  return createChatService({
    stores: { threads: createMemoryThreadStore(), messages: createMemoryMessageStore() },
    policy: {
      scopes: {
        order: {
          loadScope: (id) => (id === 'order-1' ? { id } : null),
          participants: () => ['cust-1', 'cook-1'],
        },
      },
    },
    realtime,
    presence,
    rateLimit: false,
  })
}

describe('attachChatGateway', () => {
  it('rejects handshakes without a valid token', () => {
    const { io, connect } = fakeServer()
    attachChatGateway({ io, chat: buildChat({ emitToUser: () => undefined }), identity })
    expect(connect({}).error?.message).toBe('UNAUTHENTICATED')
    expect(connect({ token: 'nope' }).error?.message).toBe('UNAUTHENTICATED')
  })

  it('verified users join their room; presence tracks multi-socket', () => {
    const { io, connect } = fakeServer()
    const presence = createPresenceTracker()
    attachChatGateway({ io, chat: buildChat({ emitToUser: () => undefined }), identity, presence })

    const a = connect({ token: 'good-token' })
    expect(a.error).toBeUndefined()
    expect(a.joined).toContain(defaultUserRoom('cust-1'))
    expect(presence.isOnline('cust-1')).toBe(true)

    const b = connect({ token: 'good-token' }) // second tab
    const disconnectA = a.handlers.get('disconnect')!
    disconnectA()
    expect(presence.isOnline('cust-1')).toBe(true) // still one socket left
    const disconnectB = b.handlers.get('disconnect')!
    disconnectB()
    expect(presence.isOnline('cust-1')).toBe(false)
  })

  it('chat:send flows through the service and acks the message', async () => {
    const { io, connect, roomEmits } = fakeServer()
    const transport = createSocketTransport(io)
    const chat = buildChat(transport)
    attachChatGateway({ io, chat, identity })

    const { handlers } = connect({ token: 'good-token' })
    const ack = vi.fn()
    await handlers.get('chat:send')!({ scopeType: 'order', scopeId: 'order-1', text: 'hello' }, ack)

    expect(ack).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ text: 'hello' }) })
    // Both participants' rooms received the message event.
    const rooms = roomEmits.filter((e) => e.event === 'chat:new_message').map((e) => e.room)
    expect(rooms.sort()).toEqual([defaultUserRoom('cook-1'), defaultUserRoom('cust-1')])
  })

  it('chat errors surface through the ack with their code', async () => {
    const { io, connect } = fakeServer()
    const chat = buildChat(createSocketTransport(io))
    attachChatGateway({ io, chat, identity })

    const { handlers } = connect({ token: 'good-token' })
    const ack = vi.fn()
    await handlers.get('chat:send')!({ scopeType: 'order', scopeId: 'order-404', text: 'hi' }, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'SCOPE_NOT_FOUND' }))
  })

  it('chat:read marks the thread read', async () => {
    const { io, connect } = fakeServer()
    const chat = buildChat(createSocketTransport(io))
    attachChatGateway({ io, chat, identity })

    // cook sends → customer has 1 unread
    const cook = connect({ token: 'cook-token' })
    await cook.handlers.get('chat:send')!({ scopeType: 'order', scopeId: 'order-1', text: 'ready!' }, vi.fn())
    const thread = await chat.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    expect(await chat.unreadCount({ threadId: thread.id, userId: 'cust-1' })).toBe(1)

    const cust = connect({ token: 'good-token' })
    const ack = vi.fn()
    await cust.handlers.get('chat:read')!({ threadId: thread.id }, ack)
    expect(ack).toHaveBeenCalledWith({ ok: true })
    expect(await chat.unreadCount({ threadId: thread.id, userId: 'cust-1' })).toBe(0)
  })

  it('inbound event names are configurable', async () => {
    const { io, connect } = fakeServer()
    const chat = buildChat(createSocketTransport(io))
    attachChatGateway({ io, chat, identity, inbound: { send: 'send_message' } })
    const { handlers } = connect({ token: 'good-token' })
    expect(handlers.has('send_message')).toBe(true)
    expect(handlers.has('chat:send')).toBe(false)
  })
})
