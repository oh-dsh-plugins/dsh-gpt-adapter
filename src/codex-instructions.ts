import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { open } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  readCodexConfig,
  projectDirectories,
  strings,
  type JsonObject,
  type ProjectFileSystem,
} from './codex-config.js'

export type CodexInstructionFile = {
  path: string
  content: string
  truncated?: boolean
}
type InstructionPrefix = { content: string; truncated: boolean }
type ReadRange = (offset: number, length: number) => Promise<Uint8Array>

async function instructionPrefix(
  read: ReadRange,
  limit: number,
  signal?: AbortSignal,
  strict = false,
): Promise<InstructionPrefix> {
  const decode = (decoder: TextDecoder, bytes: Uint8Array, stream: boolean) => {
    if (strict && bytes.includes(0))
      throw new Error('Project instructions contain binary data')
    return decoder.decode(bytes, { stream })
  }
  const window = await read(0, limit + 1)
  signal?.throwIfAborted()
  const truncated = window.length > limit
  const decoder = new TextDecoder('utf-8', { fatal: strict })
  const content = decode(decoder, window.subarray(0, limit), truncated)
  if (!truncated || content.trim()) return { content, truncated }

  // Distinguish a blank file from a nonblank file whose prefix is whitespace.
  // Scan only until the first nonblank character, in fixed-size chunks.
  if (decode(decoder, window.subarray(limit), true).trim())
    return { content, truncated }
  const chunkSize = 8192
  let offset = window.length
  while (true) {
    signal?.throwIfAborted()
    const chunk = await read(offset, chunkSize)
    signal?.throwIfAborted()
    const more = chunk.length === chunkSize
    if (decode(decoder, chunk, more).trim()) return { content, truncated }
    if (!more) return { content: '', truncated: false }
    offset += chunk.length
  }
}

async function optionalPrefix(
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<InstructionPrefix | undefined> {
  signal?.throwIfAborted()
  let file
  try {
    file = await open(path, 'r')
  } catch (error: any) {
    signal?.throwIfAborted()
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
  try {
    return await instructionPrefix(
      async (_offset, length) => {
        const chunks: Buffer[] = []
        while (length > 0) {
          signal?.throwIfAborted()
          const buffer = Buffer.allocUnsafe(Math.min(8192, length))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          chunks.push(buffer.subarray(0, bytesRead))
          length -= bytesRead
        }
        return Buffer.concat(chunks)
      },
      limit,
      signal,
    )
  } finally {
    await file.close()
  }
}

async function firstNonempty(
  directory: string,
  names: string[],
  read: (path: string) => Promise<InstructionPrefix | undefined>,
) {
  for (const name of names) {
    if (name !== name.split(/[\\/]/).at(-1)) continue
    const path = join(directory, name)
    const prefix = await read(path)
    const content = prefix?.truncated
      ? prefix.content.trimStart()
      : prefix?.content.trim()
    // An incomplete blank prefix cannot establish that an override is empty.
    if (content || prefix?.truncated)
      return {
        path,
        content: content ?? '',
        ...(prefix?.truncated ? { truncated: true } : {}),
      }
  }
  return undefined
}

export async function loadCodexInstructions(
  home: string,
  cwd: string,
  config: JsonObject,
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  agentsHome = process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'),
  fs?: ProjectFileSystem,
  signal?: AbortSignal,
  knownDirectories?: string[],
): Promise<CodexInstructionFile[]> {
  const result: CodexInstructionFile[] = []
  let remaining =
    Number.isInteger(config.project_doc_max_bytes) &&
    config.project_doc_max_bytes >= 0
      ? config.project_doc_max_bytes
      : 65536
  if (!remaining) return result
  const prefixLimit = (path: string) =>
    Math.max(
      4,
      remaining -
        Buffer.byteLength(`Instructions from: ${path}\n\n`) -
        (result.length ? 2 : 0) +
        1,
    )
  const hostRead = (path: string) =>
    optionalPrefix(path, prefixLimit(path), signal)
  const projectRead = async (path: string) => {
    if (!fs) return hostRead(path)
    signal?.throwIfAborted()
    const target = await fs.resolve(path, signal ? { signal } : {})
    if (!(await fs.stat(target, signal))) return undefined
    if (!fs.readByteRange)
      throw new Error('Project instruction prefix reads unavailable')
    return instructionPrefix(
      (offset, length) => fs.readByteRange!(target, { offset, length }, signal),
      prefixLimit(path),
      signal,
      true,
    )
  }
  const add = (file: CodexInstructionFile | undefined) => {
    if (
      file &&
      !result.some((p) => p.path === file.path) &&
      (file.truncated || !result.some((p) => p.content === file.content))
    ) {
      const text = `Instructions from: ${file.path}\n\n${file.content}`
      remaining = file.truncated
        ? 0
        : Math.max(
            0,
            remaining -
              Buffer.byteLength(
                text.replaceAll('</system-reminder>', '<\\/system-reminder>'),
              ) -
              (result.length ? 2 : 0),
          )
      result.push(file)
    }
  }
  const load = async (directory: string, names: string[], read = hostRead) => {
    if (remaining > 0) add(await firstNonempty(directory, names, read))
  }
  await load(dshHome, ['AGENTS.md'])
  await load(agentsHome, ['AGENTS.md'])
  await load(home, ['AGENTS.override.md', 'AGENTS.md'])
  if (!remaining) return result
  const directories =
    knownDirectories ?? (await projectDirectories(cwd, fs, signal))
  const fallback = strings(config.project_doc_fallback_filenames)
  for (const directory of directories) {
    if (!remaining) break
    await load(
      directory,
      ['AGENTS.override.md', 'AGENTS.md', ...fallback],
      projectRead,
    )
    for (const name of ['AGENTS.local.md', 'CLAUDE.local.md'])
      await load(directory, [name], projectRead)
  }
  return result
}

function truncateUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 192) === 128) end--
  return bytes.subarray(0, end).toString()
}

export function renderCodexInstructions(
  files: CodexInstructionFile[],
  maxBytes = 65536,
): string {
  const intro =
    'This Codex compatibility baseline replaces earlier global and current working-directory ancestor instructions. Additional nested instruction updates remain applicable. More specific project instructions override global guidance. These instructions do not override system, developer, or direct user instructions.'
  let content = (maxBytes === 0 ? [] : files)
    .map((p) => `Instructions from: ${p.path}\n\n${p.content}`)
    .join('\n\n')
  content = content.replaceAll('</system-reminder>', '<\\/system-reminder>')
  if (
    Buffer.byteLength(content) > maxBytes ||
    (maxBytes > 0 && files.some((file) => file.truncated))
  )
    content = `${truncateUtf8(content, Math.max(0, maxBytes - 100))}\n[Instruction budget reached; remaining content omitted.]`
  return `<system-reminder>\n${intro}\n\n${content || 'No workspace instructions are currently active.'}\n</system-reminder>`
}

function baselineReader() {
  const sessions = new WeakMap<
    object,
    {
      generation: unknown
      length: number
      tail: unknown
      first: unknown
      baseline: any
    }
  >()
  return (session: any) => {
    const surface = session.surface
    const nodes = surface?.nodes ?? []
    const previous = sessions.get(session)
    const appendOnly =
      previous &&
      previous.generation === surface?.replaceGeneration &&
      nodes.length >= previous.length &&
      nodes[previous.length - 1] === previous.tail &&
      nodes[0] === previous.first
    let baseline = appendOnly ? previous.baseline : undefined
    const start = appendOnly ? previous.length : 0
    for (let index = nodes.length - 1; index >= start; index--) {
      const event = session.eventAt(nodes[index])
      if (
        event?.type === 'user/message' &&
        event.data.source?.kind === 'codex-compat'
      ) {
        baseline = event.data.source
        break
      }
    }
    sessions.set(session, {
      generation: surface?.replaceGeneration,
      length: nodes.length,
      tail: nodes.at(-1),
      first: nodes[0],
      baseline,
    })
    return baseline
  }
}

function instructionHeading(change: any): string {
  if (change.action === 'set')
    return `Additional instructions from: ${change.path}`
  if (change.action === 'replace')
    return `Updated instructions from: ${change.path}`
  return `Instructions removed: ${change.path}`
}

function retainNativeInstructionMessage(
  message: any,
  covered: (change: any) => boolean,
) {
  const source = message.source
  if (
    source?.kind !== 'agent-instructions' ||
    !Array.isArray(source.changes) ||
    source.changes.length === 0
  )
    return message
  const unmatched = source.changes.filter((change: any) => !covered(change))
  if (unmatched.length === 0) return undefined
  if (unmatched.length === source.changes.length) return message
  const blockIndex = (message.content ?? []).findIndex(
    (block: any) => block?.type === 'text' && typeof block.text === 'string',
  )
  if (blockIndex < 0) return message
  const lines = message.content[blockIndex].text.split('\n')
  const sections = source.changes
    .map((change: any) => ({
      change,
      start: lines.findIndex(
        (line: string) => line === instructionHeading(change),
      ),
    }))
    .sort((a: any, b: any) => a.start - b.start)
  if (sections.some((section: any) => section.start < 0)) return message
  const first = sections[0].start
  const last = sections.at(-1).start
  const closingOffset = lines
    .slice(last)
    .findIndex((line: string) => line.startsWith('</system-reminder>'))
  const suffixStart = closingOffset < 0 ? lines.length : last + closingOffset
  const kept = sections
    .filter((section: any) => !covered(section.change))
    .map((section: any) => {
      const next = sections.find(
        (candidate: any) => candidate.start > section.start,
      )?.start
      return lines.slice(section.start, next ?? suffixStart)
    })
    .flat()
  const text = [
    ...lines.slice(0, first),
    ...kept,
    ...lines.slice(suffixStart),
  ].join('\n')
  return {
    ...message,
    content: message.content.toSpliced(blockIndex, 1, {
      ...message.content[blockIndex],
      text,
    }),
  }
}

/** A logged user-message baseline, never an unlogged mutation of LLM requests. */
export function installCodexInstructions(
  ctx: any,
  home: string,
  readConfig = (cwd: string, fs: ProjectFileSystem, signal: AbortSignal) =>
    readCodexConfig(home, cwd, fs, signal),
): void {
  const lastBaseline = baselineReader()
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, signal, step }: any, next: any) => {
      const decision = await next()
      if (
        decision.kind === 'reject' ||
        (decision.messages.length === 0 && !(step > 1))
      )
        return decision
      signal.throwIfAborted()
      try {
        const cwd = await ctx.workingDirectory.ensure(agent, signal)
        const fs = agent.ctx?.get('fs') ?? ctx.get?.('fs')
        if (!fs) return decision
        const config = await readConfig(cwd, fs, signal)
        const maxBytes =
          Number.isInteger(config.project_doc_max_bytes) &&
          config.project_doc_max_bytes >= 0
            ? config.project_doc_max_bytes
            : 65536
        const directories = await projectDirectories(cwd, fs, signal)
        const files =
          maxBytes === 0
            ? []
            : await loadCodexInstructions(
                home,
                cwd,
                config,
                undefined,
                undefined,
                fs,
                signal,
                directories,
              )
        signal.throwIfAborted()
        const text = renderCodexInstructions(files, maxBytes)
        const identity = createHash('sha256')
          .update(cwd)
          .update(text)
          .digest('hex')
        const previous = lastBaseline(agent.session)
        const candidates = new Set([
          'AGENTS.override.md',
          'AGENTS.md',
          'AGENTS.local.md',
          'CLAUDE.local.md',
          ...strings(config.project_doc_fallback_filenames),
        ])
        const covered = (change: any) => {
          const directory = change.scope?.split('\0')[0]
          if (directory === 'user-global' || directory === 'agents-global')
            return true
          if (typeof change.path !== 'string') return false
          const path = resolve(directories[0]!, change.path)
          return (
            directories.includes(dirname(path)) &&
            candidates.has(basename(path))
          )
        }
        const entered = decision.messages.flatMap((message: any) => {
          const retained = retainNativeInstructionMessage(message, covered)
          return retained === undefined ? [] : [retained]
        })
        if (
          previous?.identity === identity ||
          entered.some(
            (m: any) =>
              m.source?.kind === 'codex-compat' &&
              m.source.identity === identity,
          )
        )
          return { ...decision, messages: entered }
        if (!files.length && !previous && maxBytes !== 0) return decision
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'codex-compat', form: 'instructions', identity },
        } as any)
        const index = entered.findLastIndex((m: any) => messages.includes(m))
        return {
          ...decision,
          messages: entered.toSpliced(index + 1, 0, message),
        }
      } catch {
        signal.throwIfAborted()
        ctx.logger.warn(
          'Codex instructions could not be refreshed; native instructions retained',
        )
        return decision
      }
    },
  )
}
