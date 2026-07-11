import { describe, expect, it, vi } from 'vitest'
import { createMemoryMessageStore, createMemoryThreadStore } from '../src/memory'
import { createChatService } from '../src/service'

class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function build(overrides: Parameters<typeof createChatService>[0]['policy'] extends infer _P
  ? Partial<Omit<Parameters<typeof createChatService>[0], 'stores' | 'policy'>> & {
      scope?: Record<string, unknown>
    }
  : never = {}) {
  const emitted: Array<{ userId: string; event: string; payload: unknown }> = []
  const service = createChatService({
    stores: { threads: createMemoryThreadStore(), messages: createMemoryMessageStore() },
    policy: {
      scopes: {
        order: {
          loadScope: (id: string) => (id.startsWith('order') ? { id } : null),
          participants: () => ['a', 'b'],
          ...(overrides.scope ?? {}),
        },
      },
    },
    realtime: { emitToUser: (userId, event, payload) => void emitted.push({ userId, event, payload }) },
    rateLimit: false,
    ...overrides,
  })
  return { service, emitted }
}

const send = { scopeType: 'order', scopeId: 'order-1', senderId: 'a', text: 'hi' }

describe('adoption contracts', () => {
  it('a THROWN app error inside loadScope propagates untouched', async () => {
    const { service } = build({
      scope: {
        loadScope: () => {
          throw new AppError('CONFLICT', 409, 'Chat opens once an offer is accepted')
        },
      },
    })
    await expect(service.sendMessage(send)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
  })

  it('NOT_PARTICIPANT is decided before canPost (canPost never sees strangers)', async () => {
    const canPost = vi.fn(() => true)
    const { service } = build({ scope: { canPost } })
    await expect(service.sendMessage({ ...send, senderId: 'stranger' })).rejects.toMatchObject({
      code: 'NOT_PARTICIPANT',
    })
    expect(canPost).not.toHaveBeenCalled()
  })
})

describe('delivery resilience', () => {
  it('a throwing formatRealtimePayload never fails the send — default payload + onError', async () => {
    const onError = vi.fn()
    const { service, emitted } = build({
      onError,
      formatRealtimePayload: () => {
        throw new Error('formatter bug')
      },
    })
    const message = await service.sendMessage(send)
    expect(message.text).toBe('hi')
    expect(onError).toHaveBeenCalledWith('realtime', expect.any(Error))
    // default shape still went out
    expect(emitted[0]!.payload).toMatchObject({ scopeType: 'order', scopeId: 'order-1' })
  })

  it('a throwing emitToUser is isolated per recipient', async () => {
    const onError = vi.fn()
    const good: string[] = []
    const service = createChatService({
      stores: { threads: createMemoryThreadStore(), messages: createMemoryMessageStore() },
      policy: {
        scopes: {
          order: { loadScope: (id: string) => ({ id }), participants: () => ['a', 'b'] },
        },
      },
      realtime: {
        emitToUser: (userId) => {
          if (userId === 'a') throw new Error('socket gone')
          good.push(userId)
        },
      },
      rateLimit: false,
      onError,
    })
    await expect(service.sendMessage(send)).resolves.toBeTruthy()
    expect(good).toEqual(['b'])
    expect(onError).toHaveBeenCalledWith('realtime', expect.any(Error))
  })

  it('async presence (Promise-returning isOnline) is awaited correctly', async () => {
    const notifier = { notify: vi.fn(async () => []) }
    const { service } = build({
      notifier,
      presence: { isOnline: async (id: string) => id === 'b' }, // recipient online
    })
    await service.sendMessage(send)
    expect(notifier.notify).not.toHaveBeenCalled()
  })
})

describe('boundaries', () => {
  it('text exactly at textMaxLength passes; one more char fails', async () => {
    const { service } = build({ textMaxLength: 5 })
    await expect(service.sendMessage({ ...send, text: '12345' })).resolves.toBeTruthy()
    await expect(service.sendMessage({ ...send, text: '123456' })).rejects.toMatchObject({
      code: 'MESSAGE_TOO_LONG',
    })
  })

  it('listThreads paginates with offset/limit', async () => {
    const { service } = build()
    for (let i = 1; i <= 4; i++) {
      await service.sendMessage({ ...send, scopeId: `order-${i}` })
    }
    const page = await service.listThreads({ userId: 'b', limit: 2, offset: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(4)
  })

  it('unreadCount is 0 on a fresh thread and after reading everything', async () => {
    const { service } = build()
    const thread = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    expect(await service.unreadCount({ threadId: thread.id, userId: 'a' })).toBe(0)
    await service.sendMessage(send)
    expect(await service.unreadCount({ threadId: thread.id, userId: 'b' })).toBe(1)
    await service.markRead({ threadId: thread.id, userId: 'b' })
    expect(await service.unreadCount({ threadId: thread.id, userId: 'b' })).toBe(0)
  })
})
