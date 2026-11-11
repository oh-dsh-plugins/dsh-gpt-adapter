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

  async read<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.path(key)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true })
    }
  }
}
