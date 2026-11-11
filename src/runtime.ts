import { pruneStale, synchronize, type FetchLike } from './sync.js'
import type { SyncConfig, SyncSnapshot } from './types.js'

export type SyncStatus = {
  state: 'idle' | 'refreshing' | 'ready' | 'error' | 'stopped'
  error?: string
  fetchedAt?: string
}

/** Owns exactly one route: single-flight refresh, bounded I/O, and disposal. */
export class ModelSynchronizer {
  private snapshot: SyncSnapshot | undefined
  private pending: Promise<SyncSnapshot> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private abort: AbortController | undefined
  private stopped = false
  private started = false
  private status: SyncStatus = { state: 'idle' }

  constructor(
    private readonly readConfig: () => Promise<SyncConfig>,
    private readonly publish: (snapshot: SyncSnapshot) => Promise<void>,
    private readonly fetchImpl: FetchLike = fetch,
    initial?: SyncSnapshot,
  ) {
    this.snapshot = initial ? structuredClone(initial) : undefined
  }

  current(): SyncSnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.refresh().catch(() => undefined)
  }

  refresh(): Promise<SyncSnapshot> {
    if (this.stopped) return Promise.reject(new Error('synchronizer stopped'))
    if (this.pending) return this.pending
    if (this.timer) clearTimeout(this.timer)
    this.status = { state: 'refreshing' }
    const abort = new AbortController()
    this.abort = abort
    let interval = 30 * 60 * 1000
    this.pending = (async () => {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
      for (let attempt = 0; attempt < 2; attempt++) {
        const config = await this.readConfig()
        if (
          !Number.isFinite(config.refreshIntervalMs) ||
          config.refreshIntervalMs < 1000 ||
          config.refreshIntervalMs > 2147483647
        ) {
          throw new Error(
            'refresh interval must be between 1000 and 2147483647 ms',
          )
        }
        interval = config.refreshIntervalMs
        const result = await synchronize(
          config,
          this.snapshot,
          this.fetchImpl,
          signal,
        )
        if (this.stopped || abort.signal.aborted)
          throw new Error('synchronizer stopped')
        const latest = await this.readConfig()
        if (
          JSON.stringify(config) !== JSON.stringify(latest) ||
          config.includeModel !== latest.includeModel
        )
          continue
        await this.publish(structuredClone(result.snapshot))
        if (this.stopped || abort.signal.aborted)
          throw new Error('synchronizer stopped')
        this.snapshot = structuredClone(result.snapshot)
        this.status = { state: 'ready', fetchedAt: result.snapshot.fetchedAt }
        return this.current()!
      }
      throw new Error(
        'configuration changed during refresh; retry with the current provider settings',
      )
    })()
      .catch((error: unknown) => {
        if (!this.stopped)
          this.status = {
            state: 'error',
            error: error instanceof Error ? error.message : 'refresh failed',
          }
        throw error
      })
      .finally(() => {
        this.pending = undefined
        this.abort = undefined
        if (this.started && !this.stopped)
          this.timer = setTimeout(() => {
            void this.refresh().catch(() => undefined)
          }, interval)
      })
    return this.pending
  }

  async removeStale(ids: readonly string[]): Promise<SyncSnapshot> {
    if (this.stopped) throw new Error('synchronizer stopped')
    if (this.pending) await this.pending
    if (!this.snapshot) throw new Error('no model snapshot available')
    const next = pruneStale(this.snapshot, ids)
    await this.publish(next)
    if (this.stopped) throw new Error('synchronizer stopped')
    this.snapshot = next
    return structuredClone(next)
  }

  dispose(): void {
    this.stopped = true
    this.status = { state: 'stopped' }
    this.abort?.abort()
    if (this.timer) clearTimeout(this.timer)
  }
}
