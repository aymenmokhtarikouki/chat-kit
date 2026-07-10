import { describe, expect, it, vi } from 'vitest'
import { createMemoryMessageStore, createMemoryThreadStore } from '../src/memory'
import { createChatService } from '../src/service'
import { ScopePolicy } from '../src/types'

/**
 * A miniature yuma/lineo world: order threads between customer and cook
 * (posting closes when the order is cancelled), salon-pair threads whose
 * staff roster can drift.
 */

interface Order {
  id: string
  customerId: string
  cookId: string
  status: 'ACTIVE' | 'CANCELLED'
}

const orders = new Map<string, Order>([
  ['order-1', { id: 'order-1', customerId: 'cust-1', cookId: 'cook-1', status: 'ACTIVE' }],
  ['order-2', { id: 'order-2', customerId: 'cust-1', cookId: 'cook-1', status: 'CANCELLED' }],
])

const salonStaff = new Map<string, string[]>([['pair-1', ['owner-1']]])

function orderPolicy(): ScopePolicy<Order> {
  return {
    loadScope: (id) => orders.get(id) ?? null,
    participants: (o) => [o.customerId, o.cookId],
    canPost: ({ scope }) => scope.status !== 'CANCELLED',
  }
}

function build(overrides: {
  presence?: { isOnline: (id: string) => boolean }
  notifier?: { notify: ReturnType<typeof vi.fn> }
  rateLimit?: { windowMs: number; max: number } | false
  events?: { messageNew?: string; threadRead?: string }
} = {}) {
  const threads = createMemoryThreadStore()
  const messages = createMemoryMessageStore()
  const notifier = overrides.notifier ?? { notify: vi.fn(async () => []) }
  const emitted: Array<{ userId: string; event: string; payload: unknown }> = []
  const service = createChatService({
    stores: { threads, messages },
    policy: {
      scopes: {
        order: orderPolicy(),
        salonPair: {
          loadScope: (id) => (salonStaff.has(id) ? { id } : null),
          participants: (scope: { id: string }) => ['cust-9', ...(salonStaff.get(scope.id) ?? [])],
        },
      },
    },
    realtime: { emitToUser: (userId, event, payload) => void emitted.push({ userId, event, payload }) },
    presence: overrides.presence,
    notifier,
    rateLimit: overrides.rateLimit ?? false,
    events: overrides.events,
  })
  return { service, threads, messages, notifier, emitted }
}

describe('getOrCreateThread', () => {
  it('creates once per scope with the policy roster', async () => {
    const { service } = build()
    const a = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    const b = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    expect(a.id).toBe(b.id)
    expect(a.participantIds.sort()).toEqual(['cook-1', 'cust-1'])
  })

  it('rejects unknown scope types and missing scopes', async () => {
    const { service } = build()
    await expect(
      service.getOrCreateThread({ scopeType: 'spaceship', scopeId: 'x' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SCOPE_TYPE', status: 400 })
    await expect(
      service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-404' }),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND', status: 404 })
  })

  it('refreshes the roster when it drifts (staff joined)', async () => {
    const { service } = build()
    const before = await service.getOrCreateThread({ scopeType: 'salonPair', scopeId: 'pair-1' })
    expect(before.participantIds).toEqual(['cust-9', 'owner-1'])
    salonStaff.set('pair-1', ['owner-1', 'stylist-7'])
    const after = await service.getOrCreateThread({ scopeType: 'salonPair', scopeId: 'pair-1' })
    expect(after.id).toBe(before.id)
    expect(after.participantIds).toEqual(['cust-9', 'owner-1', 'stylist-7'])
  })
})

describe('sendMessage', () => {
  it('persists, touches the thread, and emits to every participant', async () => {
    const { service, emitted, threads } = build()
    const message = await service.sendMessage({
      scopeType: 'order',
      scopeId: 'order-1',
      senderId: 'cust-1',
      text: 'Is the couscous ready?',
    })
    expect(message.kind).toBe('USER')
    const thread = await threads.findByScope('order', 'order-1')
    expect(thread?.lastMessageAt).not.toBeNull()
    const recipients = emitted.filter((e) => e.event === 'chat:new_message').map((e) => e.userId)
    expect(recipients.sort()).toEqual(['cook-1', 'cust-1'])
  })

  it('rejects non-participants', async () => {
    const { service } = build()
    await expect(
      service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'stranger', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT', status: 403 })
  })

  it('respects canPost (posting closed on a cancelled order)', async () => {
    const { service } = build()
    await expect(
      service.sendMessage({ scopeType: 'order', scopeId: 'order-2', senderId: 'cust-1', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN', status: 403 })
  })

  it('validates text', async () => {
    const { service } = build()
    await expect(
      service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: '   ' }),
    ).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' })
    await expect(
      service.sendMessage({
        scopeType: 'order',
        scopeId: 'order-1',
        senderId: 'cust-1',
        text: 'x'.repeat(4001),
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' })
  })

  it('without presence, every OTHER participant is notified', async () => {
    const { service, notifier } = build()
    await service.sendMessage({
      scopeType: 'order',
      scopeId: 'order-1',
      senderId: 'cust-1',
      text: 'hello',
    })
    expect(notifier.notify).toHaveBeenCalledTimes(1)
    const [recipients, event] = notifier.notify.mock.calls[0]!
    expect(recipients).toEqual(['cook-1'])
    expect(event).toMatchObject({
      type: 'chat.message_received',
      data: expect.objectContaining({ scopeType: 'order', scopeId: 'order-1', preview: 'hello' }),
    })
  })

  it('with presence, only OFFLINE recipients are notified', async () => {
    const { service, notifier } = build({ presence: { isOnline: (id) => id === 'cook-1' } })
    await service.sendMessage({
      scopeType: 'order',
      scopeId: 'order-1',
      senderId: 'cust-1',
      text: 'hello',
    })
    expect(notifier.notify).not.toHaveBeenCalled() // the only recipient is online
  })

  it('notifier failure never fails the send', async () => {
    const notifier = { notify: vi.fn(async () => Promise.reject(new Error('fcm down'))) }
    const { service } = build({ notifier })
    await expect(
      service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: 'hi' }),
    ).resolves.toMatchObject({ text: 'hi' })
  })

  it('rate limits per sender with retryAfterMs', async () => {
    const { service } = build({ rateLimit: { windowMs: 10_000, max: 2 } })
    const send = () =>
      service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: 'hi' })
    await send()
    await send()
    await expect(send()).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    // The other participant is unaffected.
    await expect(
      service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cook-1', text: 'yo' }),
    ).resolves.toBeTruthy()
  })

  it('uses overridden event names (deployed clients keep working)', async () => {
    const { service, emitted } = build({ events: { messageNew: 'new_message' } })
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: 'hi' })
    expect(emitted.some((e) => e.event === 'new_message')).toBe(true)
    expect(emitted.some((e) => e.event === 'chat:new_message')).toBe(false)
  })
})

describe('postSystemMessage', () => {
  it('has no sender and notifies ALL participants', async () => {
    const { service, notifier } = build()
    const message = await service.postSystemMessage({
      scopeType: 'order',
      scopeId: 'order-1',
      text: 'Your order was accepted',
      data: { orderStatus: 'ACCEPTED' },
    })
    expect(message.kind).toBe('SYSTEM')
    expect(message.senderId).toBeNull()
    const [recipients] = notifier.notify.mock.calls[0]!
    expect((recipients as string[]).sort()).toEqual(['cook-1', 'cust-1'])
  })

  it('works even when posting is closed for users (status updates still flow)', async () => {
    const { service } = build()
    await expect(
      service.postSystemMessage({ scopeType: 'order', scopeId: 'order-2', text: 'Order cancelled' }),
    ).resolves.toMatchObject({ kind: 'SYSTEM' })
  })
})

describe('reading', () => {
  it('participants read newest-first with paging; strangers are rejected', async () => {
    const { service } = build()
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: 'one' })
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cook-1', text: 'two' })
    const thread = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })

    const messages = await service.listMessages({ threadId: thread.id, userId: 'cust-1' })
    expect(messages.map((m) => m.text)).toEqual(['two', 'one'])

    await expect(
      service.listMessages({ threadId: thread.id, userId: 'stranger' }),
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' })
  })

  it('unread counts exclude own messages and reset on markRead', async () => {
    const { service } = build()
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cust-1', text: 'q1' })
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cook-1', text: 'a1' })
    const thread = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })

    expect(await service.unreadCount({ threadId: thread.id, userId: 'cust-1' })).toBe(1)
    expect(await service.unreadCount({ threadId: thread.id, userId: 'cook-1' })).toBe(1)

    await service.markRead({ threadId: thread.id, userId: 'cust-1' })
    expect(await service.unreadCount({ threadId: thread.id, userId: 'cust-1' })).toBe(0)
  })

  it('markRead emits a read receipt to the OTHER participants', async () => {
    const { service, emitted } = build()
    const thread = await service.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    await service.markRead({ threadId: thread.id, userId: 'cust-1' })
    const receipts = emitted.filter((e) => e.event === 'chat:read')
    expect(receipts.map((r) => r.userId)).toEqual(['cook-1'])
    expect(receipts[0]!.payload).toMatchObject({ threadId: thread.id, userId: 'cust-1' })
  })

  it('listThreads carries unread counts; unreadTotal sums them', async () => {
    const { service } = build()
    await service.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cook-1', text: 'hi' })
    await service.sendMessage({ scopeType: 'salonPair', scopeId: 'pair-1', senderId: 'owner-1', text: 'welcome' })

    // cust-1 participates only in the order thread
    const { items, total } = await service.listThreads({ userId: 'cust-1' })
    expect(total).toBe(1)
    expect(items[0]!.unreadCount).toBe(1)
    expect(await service.unreadTotal({ userId: 'cust-1' })).toBe(1)
  })
})
