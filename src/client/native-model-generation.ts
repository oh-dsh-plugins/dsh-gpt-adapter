import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

const packageId = '@deepseek-ai/dsh-client-ui-settings-models'
const pluginId = 'dsh-gpt-adapter'

type Boot = {
  release?: { version?: string }
  entries?: readonly { id: string; rev: string }[]
}
type Modules = {
  entries?: {
    managed?: ReadonlyMap<
      string,
      { moduleNamespace: unknown; fiber?: { name?: string } }
    >
    revisions?: ReadonlyMap<string, string>
    release?: { matches?: boolean }
    state?: { getSnapshot(): { syncing: boolean } }
  }
  loadCache?: ReadonlyMap<string, { exports: unknown }>
  factories?: ReadonlyMap<string, { factory: Function; rev?: string }>
}

/** Keep the private browser loader contract within the preset integration. */
export function nativeModelGeneration(getModules: () => unknown) {
  const boot = (window as Window & { __DSH_BOOT__?: Boot }).__DSH_BOOT__
  const version = boot?.release?.version
  const rev = boot?.entries?.find((item) => item.id === packageId)?.rev
  const pluginRev = boot?.entries?.find((item) => item.id === pluginId)?.rev
  const hashes = new WeakMap<Function, string>()
  const modules = () => getModules() as Modules | undefined
  return {
    duringBoot() {
      const entries = modules()?.entries
      return !!(
        version &&
        rev &&
        pluginRev &&
        entries?.revisions &&
        !entries.revisions.has(pluginId) &&
        !entries.state?.getSnapshot().syncing
      )
    },
    identify(entry: StoredEntry) {
      const current = modules()
      const loader = current?.entries
      const active = loader?.managed?.get(packageId)
      const record = current?.loadCache?.get(packageId)
      const loaded = current?.factories?.get(packageId)
      const owner = entry as StoredEntry & {
        module?: string
        registrant?: string
      }
      if (
        !version ||
        !rev ||
        !active?.fiber ||
        !record ||
        !loaded ||
        loader?.release?.matches !== true ||
        loader.state?.getSnapshot().syncing ||
        loaded.rev !== rev ||
        loader.revisions?.get(packageId) !== rev ||
        active.moduleNamespace !== record.exports ||
        (owner.module !== undefined
          ? owner.module !== packageId
          : owner.registrant !== active.fiber.name) ||
        typeof loaded.factory !== 'function'
      )
        return
      let digest = hashes.get(loaded.factory)
      if (!digest) {
        digest = bytesToHex(
          sha256(utf8ToBytes(Function.prototype.toString.call(loaded.factory))),
        )
        hashes.set(loaded.factory, digest)
      }
      return { version, digest }
    },
  }
}
