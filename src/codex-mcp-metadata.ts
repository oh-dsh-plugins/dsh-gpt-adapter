import { AsyncLocalStorage } from 'node:async_hooks'
import { Client } from '@modelcontextprotocol/client'

export type CodexTurnMetadata = {
  session_id: string
  turn_id: string
}

type CallScope = {
  active: () => boolean
  metadata: CodexTurnMetadata | undefined
}
const scope = new AsyncLocalStorage<CallScope>()
let users = 0
let restore: (() => void) | undefined

/**
 * DSH 0.2.2-rc.1 has no per-call MCP metadata hook. Scope the SDK seam to
 * imported tool executions so its native lifecycle and result handling remain intact.
 */
export function installCodexMcpMetadata() {
  if (users++ === 0) {
    const original = Client.prototype.callTool
    const callTool: typeof original = function (this: Client, params, options) {
      const call = scope.getStore()
      const metadata = call?.active() ? call.metadata : undefined
      return original.call(
        this,
        metadata
          ? {
              ...params,
              _meta: { ...params._meta, 'x-codex-turn-metadata': metadata },
            }
          : params,
        options,
      )
    }
    Client.prototype.callTool = callTool
    restore = () => {
      if (Client.prototype.callTool === callTool)
        Client.prototype.callTool = original
    }
  }
  let active = true
  return {
    run<T>(metadata: CodexTurnMetadata | undefined, operation: () => T): T {
      return scope.run({ active: () => active, metadata }, operation)
    },
    dispose() {
      if (!active) return
      active = false
      if (--users === 0) {
        restore?.()
        restore = undefined
      }
    },
  }
}
