import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One plugin-owned JSON file per route/session; no API keys are written here. */
export class JsonStorage {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return join(
      this.directory,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    )
  }

  async read<T>(
    key: string,
    validate?: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    let source: string
    try {
      source = await readFile(this.path(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
    return !validate || validate(value) ? (value as T) : undefined
  }

  async write(
    key: string,
    value: unknown,
    beforeCommit?: () => void,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.path(key)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      beforeCommit?.()
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true })
    }
  }
}
