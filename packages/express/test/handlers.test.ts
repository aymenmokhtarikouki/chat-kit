import { describe, expect, it } from 'vitest'
import {
  createChatService,
  createMemoryMessageStore,
  createMemoryThreadStore,
} from '@aymenkits/chat-core'
import { createChatHandlers, MinimalRequest, MinimalResponse } from '../src/index'

function buildChat() {
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
    rateLimit: false,
  })
}

function fakeRes() {
  const state = { code: 0, body: undefined as unknown }
  const res: MinimalResponse = {
    status(code) {
      state.code = code
      return res
    },
    json(body) {
      state.body = body
      return body
    },
  }
  return { res, state }
}

function req(partial: Partial<MinimalRequest>): MinimalRequest {
  return { headers: {}, ...partial }
}

describe('createChatHandlers', () => {
  it('send → 201; threads list carries unread; markRead resets; unread total', async () => {
    const chat = buildChat()
    const h = createChatHandlers(chat, { wrapResponse: (data) => ({ data }) })

    const sent = fakeRes()
    await h.send(
      req({ auth: { userId: 'cook-1' }, body: { scopeType: 'order', scopeId: 'order-1', text: 'ready' } }),
      sent.res,
    )
    expect(sent.state.code).toBe(201)

    const threads = fakeRes()
    await h.listThreads(req({ auth: { userId: 'cust-1' } }), threads.res)
    const body = threads.state.body as { data: { items: Array<{ thread: { id: string }; unreadCount: number }> } }
    expect(body.data.items[0]!.unreadCount).toBe(1)
    const threadId = body.data.items[0]!.thread.id

    const read = fakeRes()
    await h.markRead(req({ auth: { userId: 'cust-1' }, params: { id: threadId } }), read.res)
    expect(read.state.code).toBe(200)

    const unread = fakeRes()
    await h.unreadTotal(req({ auth: { userId: 'cust-1' } }), unread.res)
    expect(unread.state.body).toMatchObject({ data: { unread: 0 } })
  })

  it('messages endpoint enforces participant access', async () => {
    const chat = buildChat()
    const thread = await chat.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    const h = createChatHandlers(chat)
    const { res, state } = fakeRes()
    await h.listMessages(req({ auth: { userId: 'stranger' }, params: { id: thread.id } }), res)
    expect(state.code).toBe(403)
    expect(state.body).toMatchObject({ error: { code: 'NOT_PARTICIPANT' } })
  })

  it('401 without auth; 400 on missing fields', async () => {
    const h = createChatHandlers(buildChat())
    const noAuth = fakeRes()
    await h.send(req({ body: {} }), noAuth.res)
    expect(noAuth.state.code).toBe(401)

    const bad = fakeRes()
    await h.send(req({ auth: { userId: 'cust-1' }, body: { text: 'hi' } }), bad.res)
    expect(bad.state.code).toBe(400)
  })
})

describe('hostile query input', () => {
  it('NaN limit/offset and garbage before-dates are ignored', async () => {
    const chat = buildChat()
    await chat.sendMessage({ scopeType: 'order', scopeId: 'order-1', senderId: 'cook-1', text: 'hi' })
    const thread = await chat.getOrCreateThread({ scopeType: 'order', scopeId: 'order-1' })
    const h = createChatHandlers(chat)

    const threads = fakeRes()
    await h.listThreads(req({ auth: { userId: 'cust-1' }, query: { limit: 'abc', offset: '-1' } }), threads.res)
    expect(threads.state.code).toBe(200)
    expect((threads.state.body as { total: number }).total).toBe(1)

    const messages = fakeRes()
    await h.listMessages(
      req({ auth: { userId: 'cust-1' }, params: { id: thread.id }, query: { before: 'not-a-date', limit: 'NaN' } }),
      messages.res,
    )
    expect(messages.state.code).toBe(200)
    expect((messages.state.body as unknown[]).length).toBe(1) // garbage date ignored, message visible
  })
})
