import { describe, it, expect } from 'vitest'
import { createAccountSync } from './account-sync.js'

function setup() {
  const items = new Map()
  const storage = {
    getItem: (k) => items.get(k) || null,
    setItem: (k, v) => items.set(k, v),
    removeItem: (k) => items.delete(k)
  }
  const cloud = new Map()
  const receipts = new Map()
  let responseLost = false
  const remote = {
    load: async (id) => cloud.get(id) || null,
    save: async (id, state, expected, mutation) => {
      if (receipts.has(mutation)) return receipts.get(mutation)
      const current = cloud.get(id)
      if ((current?.version || 0) !== expected) return { status: 'conflict', ...current }
      const result = { status: 'saved', version: expected + 1 }
      cloud.set(id, { state, version: result.version })
      receipts.set(mutation, result)
      if (responseLost) {
        responseLost = false
        throw new Error('offline')
      }
      return result
    }
  }
  let current
  let sequence = 0
  const sync = createAccountSync({
    storage,
    remote,
    empty: () => ({ workouts: [], active: null }),
    onState: (state) => {
      current = state
    },
    uuid: () => `mutation-${++sequence}`
  })
  return {
    sync,
    cloud,
    storage,
    remote,
    current: () => current,
    loseResponse: () => {
      responseLost = true
    }
  }
}

describe('account synchronization', () => {
  it('isolates guest and account caches, including pending offline edits', async () => {
    const x = setup()
    x.sync.select(null)
    x.sync.update({ workouts: ['guest'] })
    x.sync.select('one')
    x.sync.update({ workouts: ['one'] })
    x.sync.select('two')
    expect(x.current().workouts).toEqual([])
    x.sync.select('one')
    expect(x.current().workouts).toEqual(['one'])
    x.sync.select(null)
    expect(x.current().workouts).toEqual(['guest'])
    expect(x.cloud.size).toBe(0)
  })
  it('uploads a versioned snapshot without the active workout', async () => {
    const x = setup()
    x.sync.select('one')
    x.sync.update({ workouts: ['first'], active: { name: 'in progress' } })
    await x.sync.sync()
    expect(x.cloud.get('one')).toEqual({ state: { workouts: ['first'] }, version: 1 })
    expect(x.current().active).toEqual({ name: 'in progress' })
    expect(x.sync.status().dirty).toBe(false)
  })
  it('retains both copies when another device writes, until an explicit decision', async () => {
    const x = setup()
    x.sync.select('one')
    x.sync.update({ workouts: ['local'] })
    x.cloud.set('one', { state: { workouts: ['remote'] }, version: 1 })
    await x.sync.sync()
    expect(x.sync.status().conflict.state.workouts).toEqual(['remote'])
    expect(x.current().workouts).toEqual(['local'])
    await x.sync.resolve('cloud')
    expect(x.current().workouts).toEqual(['remote'])
    expect(x.sync.backup().workouts).toEqual(['local'])
  })
  it('resolves local choice using the observed cloud version', async () => {
    const x = setup()
    x.sync.select('one')
    x.sync.update({ workouts: ['local'] })
    x.cloud.set('one', { state: { workouts: ['remote'] }, version: 4 })
    await x.sync.sync()
    await x.sync.resolve('local')
    expect(x.cloud.get('one')).toEqual({ state: { workouts: ['local'] }, version: 5 })
    expect(x.sync.backup().workouts).toEqual(['remote'])
  })
  it('retries the same mutation after a lost acknowledgement', async () => {
    const x = setup()
    x.sync.select('one')
    x.sync.update({ workouts: ['first'] })
    x.loseResponse()
    await x.sync.sync()
    expect(x.sync.status().dirty).toBe(true)
    await x.sync.sync()
    expect(x.cloud.get('one').version).toBe(1)
    expect(x.sync.status().conflict).toBeNull()
    expect(x.sync.status().dirty).toBe(false)
  })
  it('does not clear a newer edit when an earlier upload finishes', async () => {
    const x = setup()
    x.sync.select('one')
    x.sync.update({ workouts: ['first'] })
    const save = x.remote.save
    let release
    x.remote.save = async (...args) => {
      await new Promise((resolve) => {
        release = resolve
      })
      return save(...args)
    }
    const pending = x.sync.sync()
    await new Promise((resolve) => setTimeout(resolve, 0))
    x.sync.update({ workouts: ['second'] })
    release()
    await pending
    expect(x.current().workouts).toEqual(['second'])
    expect(x.sync.status().dirty).toBe(true)
    x.remote.save = save
    await x.sync.sync()
    expect(x.cloud.get('one').state.workouts).toEqual(['second'])
  })
  it('ignores a response arriving after switching accounts', async () => {
    const x = setup()
    let release
    x.remote.load = () =>
      new Promise((resolve) => {
        release = resolve
      })
    x.sync.select('one')
    const pending = x.sync.sync()
    x.sync.select('two')
    x.sync.update({ workouts: ['two'] })
    release({ state: { workouts: ['one'] }, version: 2 })
    await pending
    expect(x.current().workouts).toEqual(['two'])
  })
  it('clears a transient sync error after reconnecting to an empty account', async () => {
    const x = setup()
    x.sync.select('one')
    const load = x.remote.load
    x.remote.load = async () => {
      throw new Error('offline')
    }
    await x.sync.sync()
    expect(x.sync.status().error).toBe('offline')
    x.remote.load = load
    await x.sync.sync()
    expect(x.sync.status().error).toBeNull()
  })
  it('can replace a definitively rejected pending snapshot after repairing data', async () => {
    const x = setup()
    x.sync.select('one')
    const save = x.remote.save
    x.remote.save = async (...args) => {
      if (!Array.isArray(args[1].workouts))
        throw Object.assign(new Error('Invalid collection'), { definitive: true })
      return save(...args)
    }
    x.sync.update({ workouts: 'invalid' })
    await x.sync.sync()
    x.sync.update({ workouts: ['repaired'] })
    await x.sync.sync()
    expect(x.cloud.get('one').state.workouts).toEqual(['repaired'])
    expect(x.sync.backup()).toEqual({ workouts: 'invalid' })
  })
  it('detects edits derived from a stale tab even when storage has a newer version', async () => {
    const x = setup()
    let secondState
    const second = createAccountSync({
      storage: x.storage,
      remote: x.remote,
      empty: () => ({ workouts: [], active: null }),
      onState: (s) => {
        secondState = s
      },
      uuid: () => crypto.randomUUID()
    })
    x.sync.select('one')
    second.select('one')
    x.sync.update({ workouts: ['A'] })
    await x.sync.sync()
    second.update({ ...secondState, workouts: ['B'] })
    await second.sync()
    expect(x.cloud.get('one').state.workouts).toEqual(['A'])
    expect(second.status().conflict.state.workouts).toEqual(['A'])
    expect(secondState.workouts).toEqual(['B'])
    await second.resolve('local')
    expect(x.cloud.get('one').state.workouts).toEqual(['B'])
    expect(second.backup().workouts).toEqual(['A'])
  })
})
