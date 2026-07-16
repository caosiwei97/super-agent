import {
  closeSync,
  constants,
  fstatSync,
  openSync,
} from 'node:fs'
import {
  open,
  opendir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const READ_CHUNK_BYTES = 64 * 1024
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const NON_BLOCK = constants.O_NONBLOCK ?? 0

export interface FilesystemBrokerControl {
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface FilesystemBrokerOptions {
  readonly platform?: NodeJS.Platform
  readonly procFdRoot?: string
  readonly requireDescriptorAnchoring?: boolean
}

export interface FilesystemEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
}

export interface FilesystemWalkOptions {
  readonly maxFiles: number
  readonly maxEntries: number
  readonly excludeDirectoryNames?: readonly string[]
}

interface ParentAnchor {
  readonly directory: FileHandle
  readonly pathFor: (name: string) => string
}

export class FilesystemBrokerUnavailableError extends Error {
  override readonly name = 'FilesystemBrokerUnavailableError'
}

function isWithin(root: string, candidate: string) {
  const child = relative(root, candidate)
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  )
}

function assertControl(control: FilesystemBrokerControl) {
  if (control.signal.aborted) {
    throw control.signal.reason instanceof Error
      ? control.signal.reason
      : new DOMException('Filesystem operation aborted', 'AbortError')
  }
  if (Date.now() >= control.deadline) {
    throw new DOMException('Filesystem operation deadline exceeded', 'TimeoutError')
  }
}

async function closeAll(handles: readonly FileHandle[]) {
  const errors: unknown[] = []
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Filesystem Broker 关闭目录 FD 失败')
}

/**
 * Host-side filesystem capability broker.
 *
 * Production Linux walks every parent directory through an already-open FD
 * under /proc/self/fd. This gives Node's path-only APIs an openat-like anchor
 * and prevents a renamed/symlink-swapped parent from redirecting the final IO.
 * Other platforms retain a compatibility path for development only.
 */
export class FilesystemBroker {
  readonly workspaceRoot: string
  private readonly platform: NodeJS.Platform
  private readonly procFdRoot: string
  private readonly descriptorAnchoring: boolean
  private readonly rootDescriptor?: number
  private readonly rootIdentity?: Readonly<{ dev: number; ino: number }>
  private closed = false

  constructor(workspaceRoot: string, options: FilesystemBrokerOptions = {}) {
    if (!isAbsolute(workspaceRoot)) throw new TypeError('Filesystem Broker workspace 必须是绝对路径')
    this.workspaceRoot = resolve(workspaceRoot)
    this.platform = options.platform ?? process.platform
    this.procFdRoot = options.procFdRoot ?? '/proc/self/fd'
    this.descriptorAnchoring = this.platform === 'linux'
    if (options.requireDescriptorAnchoring === true && !this.descriptorAnchoring) {
      throw new FilesystemBrokerUnavailableError('production Filesystem Broker 仅支持 Linux FD anchoring')
    }
    if (this.descriptorAnchoring) {
      try {
        this.rootDescriptor = openSync(
          this.workspaceRoot,
          constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
        )
        const metadata = fstatSync(this.rootDescriptor)
        if (!metadata.isDirectory()) throw new Error('workspace root 不是目录')
        this.rootIdentity = { dev: metadata.dev, ino: metadata.ino }
      } catch (error) {
        if (this.rootDescriptor !== undefined) closeSync(this.rootDescriptor)
        throw new FilesystemBrokerUnavailableError('Filesystem Broker 无法锚定 workspace root', {
          cause: error,
        })
      }
    }
  }

  get usesDescriptorAnchoring() {
    return this.descriptorAnchoring
  }

  async probe() {
    if (!this.descriptorAnchoring) {
      return Object.freeze({ available: false, reasonCode: 'filesystem_broker_platform_unsupported' })
    }
    try {
      await this.assertRootIdentity()
      await realpath(this.rootAnchor())
      return Object.freeze({ available: true })
    } catch {
      return Object.freeze({ available: false, reasonCode: 'filesystem_broker_fd_anchor_unavailable' })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.rootDescriptor !== undefined) closeSync(this.rootDescriptor)
  }

  async listDirectory(
    target: string,
    maxEntries: number,
    control: FilesystemBrokerControl,
  ): Promise<readonly FilesystemEntry[]> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('Filesystem Broker maxEntries 必须是正安全整数')
    }
    return this.withDirectory(target, control, async (directoryPath) => {
      const directory = await opendir(directoryPath)
      const entries: FilesystemEntry[] = []
      try {
        while (entries.length <= maxEntries) {
          assertControl(control)
          const entry = await directory.read()
          if (!entry) break
          entries.push(Object.freeze({
            name: entry.name,
            kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
          }))
        }
        return Object.freeze(entries)
      } finally {
        await directory.close().catch(() => undefined)
      }
    })
  }

  async walkFiles(
    target: string,
    options: FilesystemWalkOptions,
    control: FilesystemBrokerControl,
  ): Promise<readonly string[]> {
    for (const [field, value] of Object.entries({
      maxFiles: options.maxFiles,
      maxEntries: options.maxEntries,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Filesystem Broker ${field} 必须是正安全整数`)
      }
    }
    const excluded = new Set(options.excludeDirectoryNames ?? [])
    const absolute = this.assertTarget(target, true)
    const kind = await this.pathKind(absolute, control)
    if (kind === 'file') return Object.freeze([absolute])
    if (kind !== 'directory') return Object.freeze([])

    const files: string[] = []
    const directories = [absolute]
    let entries = 0
    while (directories.length > 0 && files.length < options.maxFiles) {
      assertControl(control)
      const directory = directories.pop()!
      const remaining = options.maxEntries - entries
      if (remaining <= 0) break
      const children = await this.listDirectory(directory, remaining, control)
      for (const child of children) {
        if (++entries > options.maxEntries) break
        const path = resolve(directory, child.name)
        if (child.kind === 'file') files.push(path)
        else if (child.kind === 'directory' && !excluded.has(child.name)) directories.push(path)
        if (files.length >= options.maxFiles) break
      }
    }
    return Object.freeze(files)
  }

  async readText(
    target: string,
    maxBytes: number,
    control: FilesystemBrokerControl,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('Filesystem Broker maxBytes 必须是正安全整数')
    }
    return this.withParent(target, control, async (parent, name) => {
      assertControl(control)
      const file = await open(parent.pathFor(name), constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
      try {
        const metadata = await file.stat()
        if (!metadata.isFile()) throw new Error(`Filesystem Broker 只允许读取普通文件: ${target}`)
        if (metadata.nlink !== 1) {
          throw new Error(`Filesystem Broker 拒绝 hardlink read: ${target}`)
        }
        if (metadata.size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节读取限制`)

        const chunks: Buffer[] = []
        let bytes = 0
        while (true) {
          assertControl(control)
          const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - bytes + 1))
          const result = await file.read(buffer, 0, buffer.byteLength, null)
          if (result.bytesRead === 0) break
          bytes += result.bytesRead
          if (bytes > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节读取限制`)
          chunks.push(buffer.subarray(0, result.bytesRead))
        }
        return Buffer.concat(chunks, bytes).toString('utf8')
      } finally {
        await file.close()
      }
    })
  }

  async writeTextAtomic(
    target: string,
    content: string,
    maxBytes: number,
    control: FilesystemBrokerControl,
  ) {
    const data = Buffer.from(content, 'utf8')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('Filesystem Broker maxBytes 必须是正安全整数')
    }
    if (data.byteLength > maxBytes) throw new Error(`写入内容超过 ${maxBytes} 字节限制`)

    return this.withParent(target, control, async (parent, name) => {
      assertControl(control)
      const mode = await this.targetMode(parent.pathFor(name)) ?? 0o600
      const temporaryName = `.super-agent-${process.pid}-${randomUUID()}.tmp`
      const temporaryPath = parent.pathFor(temporaryName)
      let temporary: FileHandle | undefined
      let renamed = false
      try {
        temporary = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          mode,
        )
        await temporary.chmod(mode)
        let offset = 0
        while (offset < data.byteLength) {
          assertControl(control)
          const result = await temporary.write(data, offset, data.byteLength - offset, offset)
          if (result.bytesWritten <= 0) throw new Error('Filesystem Broker 写入未取得进展')
          offset += result.bytesWritten
        }
        await temporary.sync()
        await temporary.close()
        temporary = undefined

        assertControl(control)
        await rename(temporaryPath, parent.pathFor(name))
        renamed = true
        await parent.directory.sync()
      } finally {
        await temporary?.close().catch(() => {})
        if (!renamed) await unlink(temporaryPath).catch(() => {})
      }
    })
  }

  private async targetMode(path: string) {
    let handle: FileHandle | undefined
    try {
      handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`Filesystem Broker 只允许替换普通文件: ${path}`)
      return metadata.mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  private async withParent<T>(
    target: string,
    control: FilesystemBrokerControl,
    action: (parent: ParentAnchor, name: string) => Promise<T>,
  ) {
    assertControl(control)
    const absolute = this.assertTarget(target, false)
    const name = basename(absolute)
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error(`Filesystem Broker 文件名非法: ${target}`)
    }

    if (!this.descriptorAnchoring) {
      const directory = await open(dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW)
      try {
        return await action({ directory, pathFor: (item) => resolve(dirname(absolute), item) }, name)
      } finally {
        await directory.close()
      }
    }

    const handles: FileHandle[] = []
    let actionError: unknown
    try {
      await this.assertRootIdentity()
      let current = await this.openRootAnchor()
      handles.push(current)
      const parentRelative = relative(this.workspaceRoot, dirname(absolute))
      for (const segment of parentRelative === '' ? [] : parentRelative.split(sep)) {
        assertControl(control)
        if (!segment || segment === '.' || segment === '..') {
          throw new Error(`Filesystem Broker 父目录片段非法: ${target}`)
        }
        current = await open(
          `${this.procFdRoot}/${current.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
        )
        handles.push(current)
      }
      const anchor = `${this.procFdRoot}/${current.fd}`
      return await action({ directory: current, pathFor: (item) => `${anchor}/${item}` }, name)
    } catch (error) {
      actionError = error
      throw error
    } finally {
      try {
        await closeAll(handles)
      } catch (closeError) {
        if (actionError) {
          throw new AggregateError([actionError, closeError], 'Filesystem Broker 操作与关闭均失败')
        }
        throw closeError
      }
    }
  }

  private async withDirectory<T>(
    target: string,
    control: FilesystemBrokerControl,
    action: (directoryPath: string) => Promise<T>,
  ) {
    assertControl(control)
    const absolute = this.assertTarget(target, true)
    if (!this.descriptorAnchoring) {
      const directory = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW)
      try {
        return await action(absolute)
      } finally {
        await directory.close()
      }
    }

    const handles: FileHandle[] = []
    let actionError: unknown
    try {
      await this.assertRootIdentity()
      let current = await this.openRootAnchor()
      handles.push(current)
      const directoryRelative = relative(this.workspaceRoot, absolute)
      for (const segment of directoryRelative === '' ? [] : directoryRelative.split(sep)) {
        assertControl(control)
        if (!segment || segment === '.' || segment === '..') {
          throw new Error(`Filesystem Broker 目录片段非法: ${target}`)
        }
        current = await open(
          `${this.procFdRoot}/${current.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
        )
        handles.push(current)
      }
      return await action(`${this.procFdRoot}/${current.fd}`)
    } catch (error) {
      actionError = error
      throw error
    } finally {
      try {
        await closeAll(handles)
      } catch (closeError) {
        if (actionError) {
          throw new AggregateError([actionError, closeError], 'Filesystem Broker 操作与关闭均失败')
        }
        throw closeError
      }
    }
  }

  private async pathKind(target: string, control: FilesystemBrokerControl) {
    if (target === this.workspaceRoot) return 'directory' as const
    return this.withParent(target, control, async (parent, name) => {
      const handle = await open(parent.pathFor(name), constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
      try {
        const metadata = await handle.stat()
        return metadata.isFile() ? 'file' as const : metadata.isDirectory() ? 'directory' as const : 'other' as const
      } finally {
        await handle.close()
      }
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return 'other' as const
      throw error
    })
  }

  private assertTarget(target: string, allowRoot: boolean) {
    const absolute = resolve(target)
    if (!isAbsolute(target)
      || !isWithin(this.workspaceRoot, absolute)
      || (!allowRoot && absolute === this.workspaceRoot)) {
      throw new Error(`Filesystem Broker 路径超出工作区或缺少文件名: ${target}`)
    }
    return absolute
  }

  private rootAnchor() {
    if (this.closed || this.rootDescriptor === undefined) {
      throw new FilesystemBrokerUnavailableError('Filesystem Broker root FD 已关闭或不可用')
    }
    return `${this.procFdRoot}/${this.rootDescriptor}`
  }

  private async assertRootIdentity() {
    if (!this.descriptorAnchoring) return
    const anchored = await this.openRootAnchor()
    let current: FileHandle | undefined
    try {
      const anchoredMetadata = await anchored.stat()
      current = await open(
        this.workspaceRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
      )
      const currentMetadata = await current.stat()
      if (anchoredMetadata.dev !== this.rootIdentity?.dev
        || anchoredMetadata.ino !== this.rootIdentity?.ino
        || currentMetadata.dev !== this.rootIdentity?.dev
        || currentMetadata.ino !== this.rootIdentity?.ino) {
        throw new FilesystemBrokerUnavailableError('Filesystem Broker workspace root identity 已变化')
      }
    } finally {
      await Promise.allSettled([anchored.close(), current?.close()])
    }
  }

  /**
   * /proc/self/fd/N is intentionally a procfs magic-link. O_NOFOLLOW would
   * reject the anchor itself with ENOTDIR on Linux, so follow that one trusted
   * hop and immediately verify the opened directory's inode. Descendant path
   * components continue to use O_NOFOLLOW.
   */
  private async openRootAnchor() {
    const anchored = await open(
      this.rootAnchor(),
      constants.O_RDONLY | constants.O_DIRECTORY,
    )
    try {
      const metadata = await anchored.stat()
      if (!metadata.isDirectory()
        || metadata.dev !== this.rootIdentity?.dev
        || metadata.ino !== this.rootIdentity?.ino) {
        throw new FilesystemBrokerUnavailableError(
          'Filesystem Broker root FD anchor identity 不匹配',
        )
      }
      return anchored
    } catch (error) {
      await anchored.close().catch(() => undefined)
      throw error
    }
  }
}
