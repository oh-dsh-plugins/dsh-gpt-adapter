import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
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
    return this.readPath(this.path(key), validate)
  }

  async readAll<T>(validate: (value: unknown) => value is T): Promise<T[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const values: T[] = []
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
      const value = await this.readPath(join(this.directory, name), validate)
      if (value !== undefined) values.push(value)
    }
    return values
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  private async readPath<T>(
    path: string,
    validate?: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    let source: string
    try {
      source = await readFile(path, 'utf8')
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
