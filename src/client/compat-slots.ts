import type {
  ConnectionHandle,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

// Existing native composer slot; no model menu is replaced or copied.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.left': { kind: 'list'; scope: 'session' }
  }
  interface SessionStandardProps {
    sessionId: SessionId
  }
}
export type ClientContext = import('@deepseek-ai/cordis').Context & {
  connection: ConnectionHandle
}
