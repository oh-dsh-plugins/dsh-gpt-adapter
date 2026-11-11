import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  optionalText,
  readCodexConfig,
  projectDirectories,
  projectText,
  strings,
  type JsonObject,
  type ProjectFileSystem,
} from './codex-config.js'

export type CodexInstructionFile = { path: string; content: string }

async function firstNonempty(
  directory: string,
  names: string[],
  read = optionalText,
) {
  for (const name of names) {
    if (name !== name.split(/[\\/]/).at(-1)) continue
    const path = join(directory, name)
    const content = (await read(path))?.trim()
    if (content) return { path, content }
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
): Promise<CodexInstructionFile[]> {
  const result: CodexInstructionFile[] = []
  const add = (file: CodexInstructionFile | undefined) => {
    if (
      file &&
      !result.some((p) => p.path === file.path || p.content === file.content)
    )
      result.push(file)
  }
  add(await firstNonempty(dshHome, ['AGENTS.md']))
  add(await firstNonempty(agentsHome, ['AGENTS.md']))
  add(await firstNonempty(home, ['AGENTS.override.md', 'AGENTS.md']))
  const directories = await projectDirectories(cwd, fs, signal)
  const read = (path: string) => projectText(path, fs, signal)
  const fallback = strings(config.project_doc_fallback_filenames)
  for (const directory of directories) {
    add(
      await firstNonempty(
        directory,
        ['AGENTS.override.md', 'AGENTS.md', ...fallback],
        read,
      ),
    )
    for (const name of ['AGENTS.local.md', 'CLAUDE.local.md'])
      add(await firstNonempty(directory, [name], read))
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
  if (Buffer.byteLength(content) > maxBytes)
    content = `${truncateUtf8(content, Math.max(0, maxBytes - 100))}\n[Instruction budget reached; remaining content omitted.]`
  return `<system-reminder>\n${intro}\n\n${content || 'No workspace instructions are currently active.'}\n</system-reminder>`
}

function lastBaseline(session: any) {
  for (const seq of [...(session.surface?.nodes ?? [])].reverse()) {
    const event = session.eventAt(seq)
    if (
      event?.type === 'user/message' &&
      event.data.source?.kind === 'codex-compat'
    )
      return event.data.source
  }
}

/** A logged user-message baseline, never an unlogged mutation of LLM requests. */
export function installCodexInstructions(ctx: any, home: string): void {
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, signal }: any, next: any) => {
      const decision = await next()
      if (decision.kind === 'reject' || decision.messages.length === 0)
        return decision
      signal.throwIfAborted()
      try {
        const cwd = await ctx.workingDirectory.ensure(agent, signal)
        const fs = agent.ctx?.get('fs') ?? ctx.get?.('fs')
        if (!fs) return decision
        const config = await readCodexConfig(home, cwd, fs, signal)
        const directories = await projectDirectories(cwd, fs, signal)
        const files = await loadCodexInstructions(
          home,
          cwd,
          config,
          undefined,
          undefined,
          fs,
          signal,
        )
        const text = renderCodexInstructions(
          files,
          Number.isInteger(config.project_doc_max_bytes) &&
            config.project_doc_max_bytes >= 0
            ? config.project_doc_max_bytes
            : 65536,
        )
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
        const entered = decision.messages.filter(
          (m: any) =>
            m.source?.kind !== 'agent-instructions' ||
            !m.source.changes?.length ||
            !m.source.changes.every(covered),
        )
        if (
          previous?.identity === identity ||
          entered.some(
            (m: any) =>
              m.source?.kind === 'codex-compat' &&
              m.source.identity === identity,
          )
        )
          return { ...decision, messages: entered }
        if (!files.length && !previous) return decision
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
