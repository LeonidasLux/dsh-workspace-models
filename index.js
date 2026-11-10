/**
 * Host half of the workspace-models bundle.
 *
 * Responsibilities:
 *  - Keep a durable map workspaceId -> model selection (provider/model/effort)
 *    in one small JSON state file under the harness home.
 *  - Apply that selection to every Agent created or resumed for a session of
 *    that workspace, before its first model request, without touching the
 *    deployment default selection.
 *  - Fold per-session token usage out of the durable Session logs, per
 *    provider/model, so the Web panel can summarize a workspace.
 *  - Serve the panel's data and mutation endpoints over fenced Web routes.
 *
 * No React, no Client imports here: this module only uses Host services found
 * through inspection (`workspaceRegistry`, `agentDefaultModel`,
 * `sessionController`, `sessionQuery`/`sessionPersistence`, `agents`,
 * `workingDirectory`, `webServer`, `connection`, `profileContext`).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Unique bundle/row identity; also the Web route prefix and the panel id. */
export const name = 'workspace-models'

/** Web route prefix served by this plugin. */
const ROUTE_PREFIX = '/workspace-models'

/** How long one model catalog read is reused by the overview endpoint. */
const CATALOG_TTL_MS = 30_000

/** Upper bound for one request body read. */
const BODY_LIMIT = 64 * 1024

/** Fold at most this many session logs concurrently while warming usage. */
const WARM_CONCURRENCY = 3

/** Delay before the background usage warm-up starts. */
const WARM_DELAY_MS = 5_000

/* ------------------------------------------------------------------ paths */

/**
 * Resolve the harness home directory that owns this plugin's own state.
 * @param {any} ctx plugin context.
 * @returns {string} absolute directory.
 */
function harnessHome(ctx) {
  const profile = ctx.get('profileContext')
  if (profile && typeof profile.home === 'string' && profile.home.length > 0) return profile.home
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    return process.env.DSH_PROFILE_DIR
  }
  return join(homedir(), '.dsh')
}

/**
 * Path of the plugin's state file.
 * @param {any} ctx plugin context.
 * @returns {string} absolute file path.
 */
function stateFile(ctx) {
  return join(harnessHome(ctx), 'workspace-models', 'state.json')
}

/* ------------------------------------------------------------ selections */

/**
 * Detached model selection, matching the Host `ModelSelection` contract.
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} Selection
 */

/**
 * Normalize an arbitrary value into a Selection, or undefined.
 * @param {unknown} value candidate.
 * @returns {Selection | undefined} validated copy.
 */
function asSelection(value) {
  if (value === null || typeof value !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  if (typeof record.provider !== 'string' || record.provider.length === 0) return undefined
  if (typeof record.model !== 'string' || record.model.length === 0) return undefined
  const selection = { provider: record.provider, model: record.model }
  if (typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0) {
    selection.reasoningEffort = record.reasoningEffort
  }
  return selection
}

/**
 * Whether two selections name the same route and effort.
 * @param {Selection | undefined} left first.
 * @param {Selection | undefined} right second.
 * @returns {boolean} equality.
 */
function sameSelection(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/* ---------------------------------------------------------------- storage */

/** Upper bound for remembered per-session selections. */
const SESSION_MEMORY_LIMIT = 2000

/** Durable workspaceId -> Selection map with serialized atomic writes. */
class WorkspaceSelectionStore {
  /** @param {string} file absolute state file path. */
  constructor(file) {
    this.file = file
    /** @type {Map<string, Selection>} */
    this.map = new Map()
    /**
     * Selection this plugin last wrote for one session, so a later resume can
     * tell our own choice from a user's explicit switch.
     * @type {Map<string, Selection>}
     */
    this.sessions = new Map()
    this.loaded = false
    this.queue = Promise.resolve()
  }

  /** Read the state file once; a missing or corrupt file starts empty. */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const workspaces = parsed && typeof parsed === 'object' ? parsed.workspaces : undefined
      if (workspaces && typeof workspaces === 'object') {
        for (const [workspaceId, value] of Object.entries(workspaces)) {
          const selection = asSelection(value)
          if (selection !== undefined) this.map.set(workspaceId, selection)
        }
      }
      const sessions = parsed && typeof parsed === 'object' ? parsed.sessions : undefined
      if (sessions && typeof sessions === 'object') {
        for (const [sessionId, value] of Object.entries(sessions)) {
          const selection = asSelection(value)
          if (selection !== undefined) this.sessions.set(sessionId, selection)
        }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn('[workspace-models] could not read state file, starting empty:', error)
      }
    }
    this.loaded = true
    return this
  }

  /**
   * Configured selection of one workspace.
   * @param {string} workspaceId workspace identity.
   * @returns {Selection | undefined} configured selection.
   */
  get(workspaceId) {
    return this.map.get(workspaceId)
  }

  /**
   * The selection this plugin last wrote for one session.
   * @param {string} sessionId session identity.
   * @returns {Selection | undefined} remembered selection.
   */
  appliedFor(sessionId) {
    return this.sessions.get(sessionId)
  }

  /**
   * Remember the selection this plugin wrote, and persist.
   * @param {string} sessionId session identity.
   * @param {Selection} selection written selection.
   * @returns {Promise<void>} after the durable write settles.
   */
  noteApplied(sessionId, selection) {
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, selection)
    while (this.sessions.size > SESSION_MEMORY_LIMIT) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    return this.persist()
  }

  /**
   * Replace or clear one workspace's selection and persist the map.
   * @param {string} workspaceId workspace identity.
   * @param {Selection | null} selection new selection, or null to clear.
   * @returns {Promise<void>} after the durable write settles.
   */
  set(workspaceId, selection) {
    if (selection === null) this.map.delete(workspaceId)
    else this.map.set(workspaceId, selection)
    return this.persist()
  }

  /**
   * Serialize one atomic state write after every earlier one.
   * @returns {Promise<void>} after this write settles.
   */
  persist() {
    const write = async () => {
      const document = {
        version: 1,
        workspaces: Object.fromEntries(this.map),
        sessions: Object.fromEntries(this.sessions),
      }
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporary, this.file)
    }
    this.queue = this.queue.then(write, write)
    return this.queue
  }
}

/* ------------------------------------------------------------------ usage */

/** Accrued token counts for one provider/model route. */
function emptyCounts() {
  return { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/**
 * Add one usage report to a counter set.
 * @param {ReturnType<typeof emptyCounts>} counts target counters.
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number }} usage provider report.
 */
function addUsage(counts, usage) {
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
  counts.requests += 1
  counts.input += input
  counts.output += output
  counts.total += Number.isFinite(usage.totalTokens) ? usage.totalTokens : input + output
  counts.cacheRead += Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  counts.cacheWrite += Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  counts.reasoning += Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0
}

/**
 * Per-session token fold keyed by provider/model, cached per process and kept
 * current for live sessions through the `session/event` feed.
 */
class UsageIndex {
  /** @param {any} ctx plugin context. */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, { seq: number, complete: boolean, failed: boolean, byModel: Map<string, { provider: string, model: string, counts: ReturnType<typeof emptyCounts> }>, lastUse: number }>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<any>>} */
    this.inflight = new Map()
  }

  /**
   * Fold one committed live event into a cached session, when it is newer.
   * @param {string} sessionId session identity.
   * @param {{ type?: string, seq?: number, data?: any }} event committed event.
   */
  observe(sessionId, event) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.failed) return
    if (typeof event?.seq !== 'number' || event.seq <= entry.seq) return
    this.foldEvent(entry, event)
    entry.seq = event.seq
  }

  /**
   * Fold one event into one session entry.
   * @param {any} entry session entry.
   * @param {{ type?: string, data?: any }} event committed event.
   */
  foldEvent(entry, event) {
    if (event.type !== 'assistant/message') return
    const data = event.data
    const usage = data?.usage
    if (usage === undefined || usage === null) return
    const source = data?.message?.source
    const provider = typeof source?.provider === 'string' ? source.provider : 'unknown'
    const model = typeof source?.model === 'string' ? source.model : 'unknown'
    const key = `${provider}\u0000${model}`
    let bucket = entry.byModel.get(key)
    if (bucket === undefined) {
      bucket = { provider, model, counts: emptyCounts() }
      entry.byModel.set(key, bucket)
    }
    addUsage(bucket.counts, usage)
  }

  /**
   * Read one session's full durable log and fold it, reusing a cached entry.
   * @param {string} sessionId session identity.
   * @returns {Promise<any>} the session entry (possibly a failure placeholder).
   */
  async ensure(sessionId) {
    const hit = this.entries.get(sessionId)
    if (hit !== undefined) return hit
    const running = this.inflight.get(sessionId)
    if (running !== undefined) return running
    const task = this.read(sessionId).finally(() => { this.inflight.delete(sessionId) })
    this.inflight.set(sessionId, task)
    return task
  }

  /**
   * Read and fold one session log from scratch.
   * @param {string} sessionId session identity.
   * @returns {Promise<any>} the created entry.
   */
  async read(sessionId) {
    const entry = { seq: -1, complete: false, failed: false, byModel: new Map(), lastUse: Date.now() }
    try {
      const { events, inherited } = await this.readEvents(sessionId)
      for (let index = inherited; index < events.length; index += 1) {
        const event = events[index]
        this.foldEvent(entry, event)
        if (typeof event?.seq === 'number') entry.seq = Math.max(entry.seq, event.seq)
      }
      entry.complete = true
    } catch (error) {
      entry.failed = true
      console.warn(`[workspace-models] could not read session ${sessionId} for token usage:`, error)
    }
    this.entries.set(sessionId, entry)
    return entry
  }

  /**
   * Read one session's committed events (live-preferred when available).
   * @param {string} sessionId session identity.
   * @returns {Promise<{ events: readonly any[], inherited: number }>} log slice.
   */
  async readEvents(sessionId) {
    const query = this.ctx.get('sessionQuery')
    if (query && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      const inherited = Number.isFinite(snapshot?.inheritedEventCount) ? snapshot.inheritedEventCount : 0
      return { events: Array.isArray(snapshot?.events) ? snapshot.events : [], inherited }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('no session log reader is composed')
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read()
      const inherited = Number.isFinite(handle.inheritedEventCount) ? handle.inheritedEventCount : 0
      return { events: Array.isArray(result?.events) ? result.events : [], inherited }
    } finally {
      await handle.close()
    }
  }

  /**
   * Cached entry of one session, without reading its log.
   * @param {string} sessionId session identity.
   * @returns {any} the entry, when already folded.
   */
  peek(sessionId) {
    return this.entries.get(sessionId)
  }

  /**
   * Aggregate one session entry into flat counters.
   * @param {string} sessionId session identity.
   * @param {ReturnType<typeof emptyCounts>} totals aggregate counters.
   * @param {Map<string, { provider: string, model: string, counts: ReturnType<typeof emptyCounts> }>} byModel aggregate routes.
   * @returns {boolean} whether the session contributed usage.
   */
  collect(sessionId, totals, byModel) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.failed) return false
    let contributed = false
    for (const bucket of entry.byModel.values()) {
      const key = `${bucket.provider}\u0000${bucket.model}`
      let target = byModel.get(key)
      if (target === undefined) {
        target = { provider: bucket.provider, model: bucket.model, counts: emptyCounts() }
        byModel.set(key, target)
      }
      for (const field of ['requests', 'input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning']) {
        target.counts[field] += bucket.counts[field]
        totals[field] += bucket.counts[field]
      }
      contributed = true
    }
    return contributed
  }
}

/* ------------------------------------------------------------------ plugin */

/**
 * Plugin entry.
 * @param {any} ctx Host plugin context.
 */
export function apply(ctx) {
  const store = new WorkspaceSelectionStore(stateFile(ctx))
  const usage = new UsageIndex(ctx)
  const ready = store.load()
  let catalogCache = { at: 0, value: { groups: [], failures: [] } }

  const defaultSelection = () => {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined) return undefined
    try {
      return asSelection(service.currentSelection())
    } catch {
      return undefined
    }
  }

  const normalizePath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  /**
   * Effective directory of one live session.
   * @param {any} agent live agent.
   * @returns {string | undefined} directory.
   */
  const sessionCwd = (agent) => {
    const session = agent?.session
    if (session === undefined || session === null) return undefined
    const directories = ctx.get('workingDirectory')
    if (directories && typeof directories.get === 'function') {
      try {
        const directory = directories.get(session)
        if (typeof directory === 'string' && directory.length > 0) return directory
      } catch {
        // fall through to the header value
      }
    }
    const cwd = session.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  }

  /**
   * Resolve the workspace that owns one session.
   * @param {string} sessionId session identity.
   * @param {string | undefined} cwd session directory.
   * @returns {any} the workspace entity, when registered.
   */
  const workspaceFor = (sessionId, cwd) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch {
      return undefined
    }
    if (cwd !== undefined) {
      const wanted = normalizePath(cwd)
      const matched = workspaces.find((workspace) => normalizePath(workspace.path) === wanted)
      if (matched !== undefined) return matched
    }
    return workspaces.find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
  }

  /**
   * Apply one workspace's configured model to a freshly created or resumed agent.
   *
   * A selection this plugin wrote earlier is replaced when the workspace model
   * changes; a selection the user made in the composer is left alone.
   * @param {any} agent live agent.
   * @returns {Promise<void>} after the selection attempt settles.
   */
  const applyToAgent = async (agent) => {
    try {
      await ready
      const session = agent?.session
      if (session === undefined || session === null) return
      const header = session.header ?? {}
      if (header.origin === 'subagent' || header.parentSession !== undefined) return
      const workspace = workspaceFor(agent.id, sessionCwd(agent))
      if (workspace === undefined) return
      const selection = store.get(workspace.id)
      if (selection === undefined) return
      const model = agent.model
      if (model === undefined || typeof model.select !== 'function') return
      let current
      try {
        current = asSelection(model.current?.())
      } catch {
        current = undefined
      }
      const written = store.appliedFor(agent.id)
      if (written !== undefined && current !== undefined && !sameSelection(current, written)) {
        // The session carries a choice this plugin did not write: a user pick.
        return
      }
      if (sameSelection(current, selection)) return
      await model.select(selection)
      await store.noteApplied(agent.id, selection)
    } catch (error) {
      console.warn('[workspace-models] could not select the workspace model:', error)
    }
  }

  /**
   * Push a selection to every live session of one workspace.
   * @param {string} workspaceId workspace identity.
   * @param {Selection | undefined} selection target selection; undefined resets to the deployment default.
   * @returns {Promise<number>} how many live agents accepted the selection.
   */
  const applyToLiveWorkspace = async (workspaceId, selection) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return 0
    const target = selection ?? defaultSelection()
    if (target === undefined) return 0
    let applied = 0
    let live = []
    try {
      live = agents.list()
    } catch {
      return 0
    }
    for (const agent of live) {
      try {
        const workspace = workspaceFor(agent.id, sessionCwd(agent))
        if (workspace === undefined || workspace.id !== workspaceId) continue
        const model = agent.model
        if (model === undefined || typeof model.select !== 'function') continue
        await model.select(target)
        await store.noteApplied(agent.id, target)
        applied += 1
      } catch (error) {
        console.warn('[workspace-models] could not retarget a live session:', error)
      }
    }
    return applied
  }

  /* live usage folding */
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (typeof id === 'string') usage.observe(id, event)
  })

  /* workspace model on every new or resumed agent */
  ctx.on('agent/created', (payload) => applyToAgent(payload?.agent))

  /* ------------------------------------------------------------ catalog */

  /**
   * Read the routable model catalog, cached briefly.
   * @param {boolean} fresh bypass the cache.
   * @returns {Promise<{ groups: readonly any[], failures: readonly any[] }>} catalog.
   */
  const loadCatalog = async (fresh = false) => {
    if (!fresh && catalogCache.at > 0 && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.modelCatalog !== 'function') {
      return { groups: [], failures: [] }
    }
    try {
      const catalog = await controller.modelCatalog()
      const value = {
        groups: Array.isArray(catalog?.groups) ? catalog.groups : [],
        failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
      }
      catalogCache = { at: Date.now(), value }
      return value
    } catch (error) {
      console.warn('[workspace-models] could not read the model catalog:', error)
      return catalogCache.value
    }
  }

  /* --------------------------------------------------------- overview IO */

  /**
   * List one record per known session without opening its log body.
   * @returns {Promise<Map<string, { id: string, cwd?: string, origin?: string }>>} session index.
   */
  const listSessionRecords = async () => {
    /** @type {Map<string, { id: string, cwd?: string, origin?: string }>} */
    const index = new Map()
    const query = ctx.get('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      try {
        for (const record of await query.listSessions()) {
          const header = record?.header
          if (header?.id === undefined) continue
          index.set(String(header.id), {
            id: String(header.id),
            cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
            origin: typeof header.origin === 'string' ? header.origin : undefined,
          })
        }
        return index
      } catch (error) {
        console.warn('[workspace-models] session list read failed, falling back to persistence:', error)
      }
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          const header = snapshot?.header
          if (header?.id === undefined) continue
          index.set(String(header.id), {
            id: String(header.id),
            cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
            origin: typeof header.origin === 'string' ? header.origin : undefined,
          })
        }
      } catch (error) {
        console.warn('[workspace-models] session persistence list failed:', error)
      }
    }
    return index
  }

  /**
   * Fold one workspace's sessions into usage counters.
   * @param {readonly string[]} sessionIds member sessions.
   * @param {Map<string, { id: string, cwd?: string, origin?: string }>} records session index.
   * @returns {Promise<{ totals: ReturnType<typeof emptyCounts>, byModel: any[], sessions: number, readable: number, liveAgents: number }>} aggregate.
   */
  const workspaceUsage = async (sessionIds, records) => {
    const totals = emptyCounts()
    /** @type {Map<string, { provider: string, model: string, counts: ReturnType<typeof emptyCounts> }>} */
    const byModel = new Map()
    let sessions = 0
    let readable = 0
    for (const sessionId of sessionIds) {
      const record = records.get(String(sessionId))
      if (record !== undefined && record.origin === 'subagent') continue
      sessions += 1
      const entry = await usage.ensure(String(sessionId))
      if (entry !== undefined && !entry.failed) readable += 1
      usage.collect(String(sessionId), totals, byModel)
    }
    const models = [...byModel.values()]
      .map((bucket) => ({ provider: bucket.provider, model: bucket.model, ...bucket.counts }))
      .sort((left, right) => right.total - left.total || left.model.localeCompare(right.model))
    return { totals, byModel: models, sessions, readable }
  }

  /**
   * Build the complete panel payload.
   * @param {boolean} refreshCatalog bypass the catalog cache.
   * @returns {Promise<any>} overview document.
   */
  const buildOverview = async (refreshCatalog = false) => {
    await ready
    const registry = ctx.get('workspaceRegistry')
    const records = await listSessionRecords()
    const catalog = await loadCatalog(refreshCatalog)
    const fallback = defaultSelection()
    const agents = ctx.get('agents')
    /** @type {Set<string>} */
    const liveWorkspaces = new Set()
    try {
      for (const agent of agents?.list?.() ?? []) {
        const workspace = workspaceFor(agent.id, sessionCwd(agent))
        if (workspace !== undefined) liveWorkspaces.add(String(workspace.id))
      }
    } catch {
      // no live registry: leave the badge empty
    }

    let workspaces = []
    try {
      workspaces = registry === undefined ? [] : registry.list()
    } catch {
      workspaces = []
    }

    const totals = emptyCounts()
    /** @type {Map<string, { provider: string, model: string, counts: ReturnType<typeof emptyCounts> }>} */
    const totalByModel = new Map()
    /* every route the current catalog can route to, from every vendor */
    const listed = new Set()
    for (const group of catalog.groups) {
      for (const model of group?.models ?? []) listed.add(`${group.id}\u0000${model.id}`)
    }
    const rows = []
    for (const workspace of workspaces) {
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      const configured = store.get(String(workspace.id))
      const aggregate = await workspaceUsage(sessionIds, records)
      for (const field of ['requests', 'input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning']) {
        totals[field] += aggregate.totals[field]
      }
      for (const model of aggregate.byModel) {
        const key = `${model.provider}\u0000${model.model}`
        let bucket = totalByModel.get(key)
        if (bucket === undefined) {
          bucket = { provider: model.provider, model: model.model, counts: emptyCounts() }
          totalByModel.set(key, bucket)
        }
        for (const field of ['requests', 'input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning']) {
          bucket.counts[field] += model[field]
        }
      }
      const effective = configured ?? fallback ?? null
      rows.push({
        id: String(workspace.id),
        title: String(workspace.title ?? workspace.path ?? ''),
        path: String(workspace.path ?? ''),
        configured: configured ?? null,
        effective,
        configuredListed: configured === undefined ? null : listed.has(`${configured.provider}\u0000${configured.model}`),
        effectiveListed: effective === null ? null : listed.has(`${effective.provider}\u0000${effective.model}`),
        sessionCount: aggregate.sessions,
        readableSessions: aggregate.readable,
        live: liveWorkspaces.has(String(workspace.id)),
        usage: aggregate.totals,
        models: aggregate.byModel,
      })
    }

    return {
      generatedAt: Date.now(),
      defaultSelection: fallback ?? null,
      defaultListed: fallback === undefined || fallback === null
        ? null
        : listed.has(`${fallback.provider}\u0000${fallback.model}`),
      totals,
      byModel: [...totalByModel.values()]
        .map((bucket) => ({ provider: bucket.provider, model: bucket.model, ...bucket.counts }))
        .sort((left, right) => right.total - left.total || left.model.localeCompare(right.model)),
      catalog,
      workspaces: rows,
      warnings: catalog.failures.map((failure) => ({
        provider: String(failure?.id ?? ''),
        message: String(failure?.message ?? ''),
      })),
    }
  }

  /* background warm-up so the first panel open is fast */
  const warm = () => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await ready
          const registry = ctx.get('workspaceRegistry')
          if (registry === undefined) return
          const records = await listSessionRecords()
          const queue = []
          for (const workspace of registry.list()) {
            for (const sessionId of workspace.sessionIds ?? []) {
              const record = records.get(String(sessionId))
              if (record !== undefined && record.origin === 'subagent') continue
              queue.push(String(sessionId))
            }
          }
          let cursor = 0
          const worker = async () => {
            while (cursor < queue.length) {
              const sessionId = queue[cursor]
              cursor += 1
              await usage.ensure(sessionId)
            }
          }
          await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker))
        } catch (error) {
          console.warn('[workspace-models] usage warm-up failed:', error)
        }
      })()
    }, WARM_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }
  ctx.effect(warm, 'workspace-models: usage warm-up')

  /* ------------------------------------------------------------- routes */

  /**
   * Whether a Web request may reach this plugin's routes.
   * @param {any} request Node request.
   * @returns {boolean} true when the connection admits the peer.
   */
  const admitted = (request) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return true
    try {
      return connection.requestRejection(request) === undefined
    } catch {
      return false
    }
  }

  /**
   * Write one JSON response.
   * @param {any} response Node response.
   * @param {number} status HTTP status.
   * @param {unknown} body JSON body.
   */
  const sendJson = (response, status, body) => {
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    response.end(text)
  }

  /**
   * Read one JSON request body.
   * @param {any} request Node request.
   * @returns {Promise<any>} parsed body.
   */
  const readJson = async (request) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > BODY_LIMIT) throw new Error('request body is too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /**
   * Handle one request under the plugin's route prefix.
   * @param {any} request Node request.
   * @param {any} response Node response.
   * @returns {Promise<void>} after the response settles.
   */
  const handle = async (request, response) => {
    if (!admitted(request)) {
      sendJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.replace(/\/+$/, '')
    try {
      if (route === `${ROUTE_PREFIX}/overview`) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(response, 200, { ok: true, overview: await buildOverview(url.searchParams.get('refresh') === '1') })
        return
      }
      if (route === `${ROUTE_PREFIX}/config`) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJson(request)
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : ''
        if (workspaceId.length === 0) {
          sendJson(response, 400, { ok: false, error: 'workspaceId is required' })
          return
        }
        const cleared = body?.model === null || body?.model === undefined
        const selection = cleared ? null : asSelection(body.model)
        if (!cleared && selection === undefined) {
          sendJson(response, 400, { ok: false, error: 'model must name a provider and a model id' })
          return
        }
        let listed = null
        if (selection !== null) {
          /* Any provider/model route is accepted: a vendor may be configured
             after this pin, or the catalog may simply not advertise it yet.
             The answer says whether the catalog currently lists it, so the
             panel can flag the pin instead of refusing it. */
          const catalog = await loadCatalog()
          listed = catalog.groups.some((group) => group?.id === selection.provider
            && Array.isArray(group?.models)
            && group.models.some((model) => model?.id === selection.model))
        }
        await store.set(workspaceId, selection)
        const applied = await applyToLiveWorkspace(workspaceId, selection ?? undefined)
        sendJson(response, 200, { ok: true, configured: selection, listed, appliedToLiveSessions: applied })
        return
      }
      sendJson(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      console.warn('[workspace-models] request failed:', error)
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    if (server === undefined || typeof server.register !== 'function') {
      console.warn('[workspace-models] webServer is unavailable; the panel has no data source')
      return () => {}
    }
    return server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
  }), 'workspace-models: routes')
}
