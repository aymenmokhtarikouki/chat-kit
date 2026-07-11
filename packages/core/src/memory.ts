/**
 * In-memory stores — reference implementations for tests, demos and as
 * living documentation of each method's contract. Real apps implement the
 * stores on their own schema (Prisma, raw SQL, anything).
 */
import { ChatMessage, ChatThread, MessageKind, MessageStore, ThreadStore } from './types'

export function createMemoryThreadStore(): ThreadStore & { rows: ChatThread[] } {
  const rows: ChatThread[] = []
  const readAt = new Map<string, Date>() // `${threadId}:${userId}`
  let seq = 0

  const clone = (t: ChatThread): ChatThread => ({ ...t, participantIds: [...t.participantIds] })

  return {
    rows,

    async create(data) {
      const thread: ChatThread = {
        id: `thr_${++seq}`,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
        participantIds: [...data.participantIds],
        createdAt: new Date(),
        lastMessageAt: null,
      }
      rows.push(thread)
      return clone(thread)
    },

    async findByScope(scopeType, scopeId) {
      const row = rows.find((t) => t.scopeType === scopeType && t.scopeId === scopeId)
      return row ? clone(row) : null
    },

    async findById(id) {
      const row = rows.find((t) => t.id === id)
      return row ? clone(row) : null
    },

    async listForUser(userId, { limit, offset }) {
      const matches = rows
        .filter((t) => t.participantIds.includes(userId))
        .sort(
          (a, b) =>
            (b.lastMessageAt ?? b.createdAt).getTime() - (a.lastMessageAt ?? a.createdAt).getTime(),
        )
      return { items: matches.slice(offset, offset + limit).map(clone), total: matches.length }
    },

    async touch(threadId, at) {
      const row = rows.find((t) => t.id === threadId)
      if (row) row.lastMessageAt = at
    },

    async setParticipants(threadId, participantIds) {
      const row = rows.find((t) => t.id === threadId)
      if (row) row.participantIds = [...participantIds]
    },

    async markRead(threadId, userId, at) {
      readAt.set(`${threadId}:${userId}`, at)
    },

    async getReadAt(threadId, userId) {
      return readAt.get(`${threadId}:${userId}`) ?? null
    },
  }
}

export function createMemoryMessageStore(): MessageStore & { rows: ChatMessage[] } {
  const rows: ChatMessage[] = []
  let seq = 0
  let tick = 0 // strictly increasing creation order, stable within one ms

  const order = new Map<string, number>()

  return {
    rows,

    async create(data) {
      const message: ChatMessage = {
        id: `msg_${++seq}`,
        threadId: data.threadId,
        senderId: data.senderId,
        kind: data.kind as MessageKind,
        text: data.text,
        data: data.data,
        createdAt: new Date(),
      }
      rows.push(message)
      order.set(message.id, ++tick)
      return { ...message }
    },

    async list(threadId, { before, limit }) {
      return rows
        .filter((m) => m.threadId === threadId && (!before || m.createdAt < before))
        .sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)) // newest first
        .slice(0, limit)
        .map((m) => ({ ...m }))
    },

    async countOthersSince(threadId, userId, since) {
      return rows.filter(
        (m) =>
          m.threadId === threadId &&
          m.senderId !== userId &&
          (since === null || m.createdAt > since),
      ).length
    },
  }
}
