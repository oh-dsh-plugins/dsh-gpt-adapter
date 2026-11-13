import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorage } from '../src/storage.js'

describe('route cache commit guard', () => {
  it('preserves the previous file and removes the temporary file when the publisher expires', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-test-'))
    try {
      const storage = new JsonStorage(directory)
      await storage.write('route:fixture', { capacity: 1000000 })
      await expect(
        storage.write('route:fixture', { capacity: 128000 }, () => {
          throw new Error('publisher expired')
        }),
      ).rejects.toThrow('publisher expired')
      expect(await storage.read('route:fixture')).toEqual({ capacity: 1000000 })
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
