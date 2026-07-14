import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class WorkspaceBoundaryError extends Error {
  constructor(path: string) {
    super(`路径超出工作区范围: ${path}`)
    this.name = 'WorkspaceBoundaryError'
  }
}

function isWithin(root: string, candidate: string) {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

/**
 * Resolves tool paths against one explicit workspace root.
 *
 * Existing paths are checked through realpath to prevent symlink escapes.
 * New write targets validate their existing parent for the same reason.
 */
export class Workspace {
  readonly root: string

  constructor(root: string) {
    const resolvedRoot = resolve(root)
    if (!existsSync(resolvedRoot)) throw new Error(`工作区不存在: ${resolvedRoot}`)
    this.root = realpathSync(resolvedRoot)
  }

  resolveExisting(path: string) {
    const candidate = this.resolveLexically(path)
    if (!existsSync(candidate)) throw new Error(`路径不存在: ${path}`)

    const realCandidate = realpathSync(candidate)
    if (!isWithin(this.root, realCandidate)) throw new WorkspaceBoundaryError(path)
    return realCandidate
  }

  resolveForWrite(path: string) {
    const candidate = this.resolveLexically(path)
    try {
      // lstat sees dangling symlinks that existsSync intentionally treats as
      // missing. Such a link must never be followed by writeFile.
      lstatSync(candidate)
      return this.resolveExisting(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }

    let realParent: string
    try {
      realParent = realpathSync(dirname(candidate))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`父目录不存在: ${dirname(path)}`)
      }
      throw error
    }
    if (!isWithin(this.root, realParent)) throw new WorkspaceBoundaryError(path)
    return candidate
  }

  private resolveLexically(path: string) {
    const candidate = resolve(this.root, path)
    if (!isWithin(this.root, candidate)) throw new WorkspaceBoundaryError(path)
    return candidate
  }
}
