/** Bound MCP startup work across Agent scopes; established clients keep their owners. */
export class McpStartupSlots {
  private active = 0
  private readonly waiting = new Set<() => void>()

  constructor(private readonly maximum = 4) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', aborted)
          resolve()
        }
        const aborted = () => {
          this.waiting.delete(ready)
          reject(signal.reason)
        }
        this.waiting.add(ready)
        signal.addEventListener('abort', aborted, { once: true })
      })
    } else {
      this.active++
    }
    if (signal.aborted) {
      this.release()
      signal.throwIfAborted()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  private release(): void {
    const next = this.waiting.values().next().value
    if (next) {
      this.waiting.delete(next)
      next()
    } else {
      this.active--
    }
  }
}
