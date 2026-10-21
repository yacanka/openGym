// The persisted pending snapshot is immutable until acknowledged. Retrying that exact
// mutation lets the server distinguish a lost response from a competing device write.
export function createAccountSync({
  storage,
  remote,
  empty,
  onState,
  onStatus = () => {},
  uuid = () => crypto.randomUUID()
}) {
  let selected = null
  let generation = 0
  let displayed = null
  const flights = new Map()
  const key = (id) => 'gym_account_v2:' + (id || 'guest')
  const fresh = () => ({
    state: empty(),
    version: 0,
    revision: 0,
    dirty: false,
    pending: null,
    conflict: null,
    backup: null,
    error: null
  })
  const read = (id) => {
    const raw = storage.getItem(key(id))
    if (!raw) return fresh()
    return { ...fresh(), ...JSON.parse(raw) }
  }
  const write = (id, record, token = generation) => {
    storage.setItem(key(id), JSON.stringify(record))
    if (id === selected && token === generation) {
      displayed = JSON.parse(JSON.stringify(record))
      onState(record.state)
      onStatus(record)
    }
  }
  const conflict = (id, record, cloud, token) => {
    record.conflict = { state: cloud.state || empty(), version: cloud.version || 0 }
    record.pending = null
    write(id, record, token)
  }
  const upload = async (id, token) => {
    let record = read(id)
    const pending = record.pending
    const result = await remote.save(id, pending.state, pending.version, pending.id)
    record = read(id)
    if (result.status === 'conflict') {
      conflict(id, record, result, token)
      return false
    }
    record.version = Math.max(record.version, result.version)
    if (record.pending?.id === pending.id) {
      record.dirty = record.revision !== pending.revision
      record.pending = null
    }
    record.error = null
    write(id, record, token)
    return true
  }
  const perform = async (id, token) => {
    try {
      let record = read(id)
      if (record.conflict) return
      if (record.pending) {
        // Finish the ambiguous request before comparing remote versions.
        if (!(await upload(id, token))) return
      }
      const cloud = await remote.load(id)
      record = read(id)
      if (id !== selected || token !== generation) return
      if (record.dirty && (cloud?.version || 0) !== record.version) {
        conflict(id, record, cloud || { state: empty(), version: 0 }, token)
        return
      }
      if (!record.dirty && cloud) {
        record.state = { ...empty(), ...cloud.state, active: record.state.active || null }
        record.version = cloud.version
        record.error = null
        write(id, record, token)
      }
      if (!record.dirty) {
        record.error = null
        write(id, record, token)
        return
      }
      const { active: _active, ...state } = record.state
      record.pending = { state, version: record.version, revision: record.revision, id: uuid() }
      write(id, record, token)
      await upload(id, token)
    } catch (error) {
      const record = read(id)
      if (error.definitive && record.pending) {
        // The server confirmed no commit occurred. Keep the rejected data as a
        // backup, but let an import/reset replace it instead of retrying forever.
        record.backup = record.pending.state
        record.pending = null
      }
      record.error = error.message || 'Sync unavailable'
      write(id, record, token)
    }
  }
  const api = {
    select(id) {
      selected = id
      generation++
      const record = read(id)
      displayed = JSON.parse(JSON.stringify(record))
      onState(record.state)
      onStatus(record)
      return record.state
    },
    update(state, dirty = true) {
      const shared = read(selected)
      const stale =
        selected && displayed && JSON.stringify(shared.state) !== JSON.stringify(displayed.state)
      const record = stale
        ? {
            ...displayed,
            pending: null,
            conflict: { state: shared.state, version: shared.version, source: 'tab' }
          }
        : shared
      record.state = state
      record.revision = Math.max(record.revision, shared.revision) + 1
      record.dirty = selected !== null && (dirty || record.dirty)
      write(selected, record)
    },
    status: () => read(selected),
    backup: () => read(selected).backup,
    guest: () => read(null).state,
    sync() {
      const id = selected
      if (!id) return Promise.resolve()
      if (flights.has(id)) return flights.get(id)
      const run = perform(id, generation).finally(() => {
        flights.delete(id)
      })
      flights.set(id, run)
      return run
    },
    async resolve(choice) {
      if (!['local', 'cloud'].includes(choice)) throw new Error('Invalid conflict resolution')
      const record = read(selected)
      if (!record.conflict) return
      const cloud = record.conflict
      record.backup = choice === 'cloud' ? record.state : cloud.state
      record.version = cloud.version
      if (choice === 'cloud')
        record.state = { ...empty(), ...cloud.state, active: record.state.active || null }
      record.dirty = choice === 'local' || cloud.source === 'tab'
      record.conflict = null
      record.pending = null
      record.revision++
      write(selected, record)
      if (record.dirty) await api.sync()
    }
  }
  return api
}
