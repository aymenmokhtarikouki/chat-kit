import { describe, expect, it, vi } from 'vitest'
import { createGroupService, createMemoryGroupStore, groupScope } from '../src/groups'
import { createMemoryMessageStore, createMemoryThreadStore } from '../src/memory'
import { createChatService } from '../src/service'

function build() {
  const groupStore = createMemoryGroupStore()
  const threads = createMemoryThreadStore()
  const messages = createMemoryMessageStore()
  const notifier = { notify: vi.fn(async () => []) }
  const emitted: Array<{ userId: string; event: string }> = []
  const chat = createChatService({
    stores: { threads, messages },
    policy: { scopes: { group: groupScope(groupStore) } },
    realtime: { emitToUser: (userId, event) => void emitted.push({ userId, event }) },
    notifier,
    rateLimit: false,
  })
  const groups = createGroupService({ store: groupStore, chat })
  return { groups, chat, threads, messages, notifier, emitted }
}

describe('group lifecycle', () => {
  it('creator is owner; members chat together; everyone gets deliveries', async () => {
    const { groups, chat, emitted } = build()
    const g = await groups.createGroup({ creatorId: 'alice', name: 'Trip 🎉', memberIds: ['bob', 'carol'] })
    expect(g.members).toEqual([
      { userId: 'alice', role: 'owner' },
      { userId: 'bob', role: 'member' },
      { userId: 'carol', role: 'member' },
    ])

    await chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId: 'bob', text: 'hi all' })
    const recipients = emitted.filter((e) => e.event === 'chat:new_message').map((e) => e.userId)
    // creation system message + bob's message both fan out to all three
    expect(new Set(recipients)).toEqual(new Set(['alice', 'bob', 'carol']))

    // Non-members stay out.
    await expect(
      chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId: 'mallory', text: 'hey' }),
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' })
  })

  it('membership events land as system messages with structured data', async () => {
    const { groups, chat } = build()
    const g = await groups.createGroup({ creatorId: 'alice', name: 'Team' })
    await groups.addMembers({ groupId: g.id, actorId: 'alice', memberIds: ['bob'] })
    const thread = await chat.getOrCreateThread({ scopeType: 'group', scopeId: g.id })
    const log = await chat.listMessages({ threadId: thread.id, userId: 'alice' })
    const kinds = log.map((m) => m.kind)
    expect(kinds.every((k) => k === 'SYSTEM')).toBe(true)
    expect(log[0]!.data).toMatchObject({ type: 'group.members_added', actorId: 'alice', userIds: ['bob'] })
    expect(log[1]!.data).toMatchObject({ type: 'group.created', name: 'Team' })
  })

  it('added members join the roster immediately; removed members lose access', async () => {
    const { groups, chat } = build()
    const g = await groups.createGroup({ creatorId: 'alice', name: 'Team', memberIds: ['bob'] })

    await groups.addMembers({ groupId: g.id, actorId: 'alice', memberIds: ['dave'] })
    await expect(
      chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId: 'dave', text: 'thanks!' }),
    ).resolves.toBeTruthy()

    await groups.removeMember({ groupId: g.id, actorId: 'alice', memberId: 'dave' })
    await expect(
      chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId: 'dave', text: 'hello?' }),
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' })
  })

  it('duplicate adds are skipped; member cap enforced; empty names rejected', async () => {
    const { groups } = build()
    const g = await groups.createGroup({ creatorId: 'a', name: 'G', memberIds: ['b', 'b', 'a'] })
    expect(g.members).toHaveLength(2) // creator + b, dupes collapsed

    const same = await groups.addMembers({ groupId: g.id, actorId: 'a', memberIds: ['b'] })
    expect(same.members).toHaveLength(2)

    await expect(groups.createGroup({ creatorId: 'a', name: '   ' })).rejects.toMatchObject({
      code: 'EMPTY_MESSAGE',
    })

    const tiny = createGroupService({ store: createMemoryGroupStore(), chat: build().chat, maxMembers: 2 })
    await expect(
      tiny.createGroup({ creatorId: 'a', name: 'G', memberIds: ['b', 'c'] }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN' })
  })
})

describe('permissions', () => {
  async function team() {
    const ctx = build()
    const g = await ctx.groups.createGroup({ creatorId: 'owner', name: 'T', memberIds: ['admin', 'm1', 'm2'] })
    await ctx.groups.setRole({ groupId: g.id, actorId: 'owner', memberId: 'admin', role: 'admin' })
    return { ...ctx, g }
  }

  it('members cannot manage; admins add/remove members; nobody removes the owner', async () => {
    const { groups, g } = await team()
    await expect(
      groups.addMembers({ groupId: g.id, actorId: 'm1', memberIds: ['x'] }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN' })

    await expect(
      groups.addMembers({ groupId: g.id, actorId: 'admin', memberIds: ['x'] }),
    ).resolves.toBeTruthy()
    await expect(
      groups.removeMember({ groupId: g.id, actorId: 'admin', memberId: 'm1' }),
    ).resolves.toBeTruthy()

    await expect(
      groups.removeMember({ groupId: g.id, actorId: 'admin', memberId: 'owner' }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN' })
  })

  it('admins cannot remove admins; only the owner changes roles', async () => {
    const { groups, g } = await team()
    await groups.setRole({ groupId: g.id, actorId: 'owner', memberId: 'm1', role: 'admin' })
    await expect(
      groups.removeMember({ groupId: g.id, actorId: 'admin', memberId: 'm1' }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN' })
    await expect(
      groups.setRole({ groupId: g.id, actorId: 'admin', memberId: 'm2', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'POST_FORBIDDEN' })
  })

  it('owner cannot leave; ownership transfer demotes the old owner and then leaving works', async () => {
    const { groups, g } = await team()
    await expect(groups.leaveGroup({ groupId: g.id, userId: 'owner' })).rejects.toMatchObject({
      code: 'POST_FORBIDDEN',
    })

    const transferred = await groups.setRole({ groupId: g.id, actorId: 'owner', memberId: 'admin', role: 'owner' })
    const roles = Object.fromEntries(transferred.members.map((m) => [m.userId, m.role]))
    expect(roles['admin']).toBe('owner')
    expect(roles['owner']).toBe('admin') // exactly one owner at all times

    await expect(groups.leaveGroup({ groupId: g.id, userId: 'owner' })).resolves.toBeTruthy()
  })

  it('members can always leave; leaving posts a system message', async () => {
    const { groups, chat, g } = await team()
    await groups.leaveGroup({ groupId: g.id, userId: 'm2' })
    const thread = await chat.getOrCreateThread({ scopeType: 'group', scopeId: g.id })
    const [latest] = await chat.listMessages({ threadId: thread.id, userId: 'owner', limit: 1 })
    expect(latest!.data).toMatchObject({ type: 'group.member_left', userId: 'm2' })
  })
})

describe('read states (seen by)', () => {
  it('reports readAt per participant, null for the unread', async () => {
    const { groups, chat } = build()
    const g = await groups.createGroup({ creatorId: 'alice', name: 'T', memberIds: ['bob', 'carol'] })
    await chat.sendMessage({ scopeType: 'group', scopeId: g.id, senderId: 'alice', text: 'lunch?' })
    const thread = await chat.getOrCreateThread({ scopeType: 'group', scopeId: g.id })
    await chat.markRead({ threadId: thread.id, userId: 'bob' })

    const states = await chat.readStates({ threadId: thread.id, userId: 'alice' })
    const byUser = Object.fromEntries(states.map((s) => [s.userId, s.readAt]))
    expect(byUser['bob']).toBeInstanceOf(Date)
    expect(byUser['carol']).toBeNull()
    expect(states).toHaveLength(3)

    await expect(chat.readStates({ threadId: thread.id, userId: 'mallory' })).rejects.toMatchObject({
      code: 'NOT_PARTICIPANT',
    })
  })
})
