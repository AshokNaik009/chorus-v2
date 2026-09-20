/**
 * Reading directories, for the file explorer.
 *
 * The client has no filesystem access of its own and this is what keeps it that way.
 * That is deliberate rather than incidental: `--config` is handed to the *daemon*
 * because the daemon owns the files, and an SSH client would then need nothing but the
 * socket. A tree drawn from `readdir` in the client would quietly undo that.
 *
 * ## Containment
 *
 * Every path is resolved against a root and checked after symlinks are followed, not
 * before. A check on the lexical path would pass `root/link` and then read whatever
 * `link` pointed at — which is how a listing walks out of the repository it claims to
 * be showing.
 *
 * ## Lazily, one directory at a time
 *
 * A tree is expanded a node at a time rather than walked whole. A checkout with a
 * `node_modules` in it is hundreds of thousands of entries, and the ones on screen are
 * the few dozen a person has actually opened.
 */

import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { ErrorCodes } from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'

export interface FsEntry {
  readonly name: string
  /** `dir`, `file`, or `other` for sockets, devices and the like. */
  readonly kind: 'dir' | 'file' | 'other'
  /** The entry is a symlink, whatever it points at. */
  readonly link: boolean
}

export interface FsListing {
  /** The directory listed, relative to the root. `''` is the root itself. */
  readonly path: string
  readonly entries: readonly FsEntry[]
}

/**
 * Directories first, then files, each case-insensitively by name.
 *
 * Dotfiles sort with everything else rather than to the top: a leading `.` is part of
 * the name, and a `.github` belongs beside `docs`, not above the source tree.
 */
function compare(a: FsEntry, b: FsEntry): number {
  if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** Is `child` inside `root`, once both are real paths? */
function contains(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export class FsService {
  /**
   * List one directory under `root`.
   *
   * `relative` is repo-relative and may be `''`. An absolute or `..`-laden value is not
   * an error to sanitize away — it is a caller with a bug or worse, so it is refused.
   */
  async list(root: string, relative: string): Promise<FsListing> {
    if (isAbsolute(relative)) {
      throw new RequestError(ErrorCodes.badRequest, 'path must be relative to the root')
    }
    const realRoot = await this.real(root)
    const target = await this.real(resolve(realRoot, relative))
    if (!contains(realRoot, target)) {
      throw new RequestError(ErrorCodes.badRequest, `path escapes the root: ${relative}`)
    }

    let dirents
    try {
      dirents = await readdir(target, { withFileTypes: true })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOTDIR') throw new RequestError(ErrorCodes.badRequest, `not a directory: ${relative}`)
      throw new RequestError(ErrorCodes.badRequest, `cannot read ${relative || '.'}`)
    }

    const entries: FsEntry[] = dirents.map((dirent) => ({
      name: dirent.name,
      // A symlink reports as a link and *not* as a directory here, because saying which
      // it points at means following it — one stat per entry, on every listing. The
      // client finds out by expanding it, which is when it matters.
      kind: dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other',
      link: dirent.isSymbolicLink()
    }))
    entries.sort(compare)
    return { path: relative, entries }
  }

  private async real(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      throw new RequestError(ErrorCodes.badRequest, `no such directory: ${path}`)
    }
  }
}

/** Join a root and a repo-relative path for display. Exported for the tree's own use. */
export function underRoot(root: string, relative: string): string {
  return relative === '' ? root : join(root, relative)
}
