#!/usr/bin/env node
/**
 * Assert that a shipped Linux `.node` needs no glibc newer than the floor.
 *
 * ## The outage this exists to prevent
 *
 * glibc's 2.32–2.34 libpthread/libutil merge relocated three symbols node-pty uses:
 *
 * | Symbol | Moved to | node-pty's use |
 * |---|---|---|
 * | `pthread_sigmask` | `GLIBC_2.32` | reset the child's signal mask |
 * | `openpty` | `GLIBC_2.34` | allocate the pty |
 * | `forkpty` | `GLIBC_2.34` | fork the shell |
 *
 * Compile on a current CI runner and the *build is green*; the loader then refuses the
 * binary on Ubuntu 20.04, Debian 11 and RHEL 9 with `version 'GLIBC_2.34' not found`.
 * Orca shipped exactly that and broke launch (their #9902). A green build on a newer
 * runner is not evidence, which is why PHASE-5 criterion 8 asks for this check.
 *
 * ## Why an ELF parser and not `readelf`
 *
 * This has to run in CI on whatever image built the slot — including Alpine, where
 * binutils is not installed by default, and on macOS where it does not exist at all.
 * A 60-line reader of `.gnu.version_r` has no dependencies and cannot be absent.
 *
 * Usage:
 *   node scripts/check-glibc-floor.mjs <file.node> [--floor 2.31]
 */

import { readFileSync } from 'node:fs'

/** Orca's floor, and ours: glibc 2.31 is Ubuntu 20.04, the oldest distro we claim. */
export const DEFAULT_GLIBC_FLOOR = '2.31'

/** Compare dotted numeric versions. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Read the versioned symbol requirements out of an ELF file.
 *
 * Walks `.gnu.version_r` (SHT_GNU_verneed), which is a linked list of `Elf_Verneed`
 * records — one per needed library — each with its own linked list of `Elf_Vernaux`
 * records naming the versions required from it. Both lists use byte offsets from
 * their own record, not indices, which is why this walks rather than iterates.
 *
 * Returns `{ library -> [versions] }`, or null when the file is not ELF.
 */
export function readVersionRequirements(buffer) {
  if (buffer.length < 64) return null
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) return null

  const is64 = buffer[4] === 2
  const littleEndian = buffer[5] === 1
  if (!is64) throw new Error('only 64-bit ELF is supported; no 32-bit slot is shipped')

  const u16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset))
  const u32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset))
  const u64 = (offset) => Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset))

  // ELF64 header: e_shoff at 0x28, e_shentsize 0x3a, e_shnum 0x3c, e_shstrndx 0x3e.
  const sectionOffset = u64(0x28)
  const sectionSize = u16(0x3a)
  const sectionCount = u16(0x3c)
  const stringIndex = u16(0x3e)
  if (sectionOffset === 0 || sectionCount === 0) return {}

  const sectionAt = (index) => {
    const base = sectionOffset + index * sectionSize
    return {
      name: u32(base),
      type: u32(base + 4),
      offset: u64(base + 0x18),
      size: u64(base + 0x20),
      link: u32(base + 0x28)
    }
  }

  const shstr = sectionAt(stringIndex)
  const nameAt = (table, offset) => {
    const start = table + offset
    const end = buffer.indexOf(0, start)
    return buffer.toString('utf8', start, end === -1 ? start : end)
  }

  let verneed = null
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionAt(i)
    // SHT_GNU_verneed is 0x6ffffffe.
    if (section.type === 0x6ffffffe || nameAt(shstr.offset, section.name) === '.gnu.version_r') {
      verneed = section
      break
    }
  }
  if (verneed === null) return {}

  // The version strings live in the linked string table, not in `.shstrtab`.
  const strtab = sectionAt(verneed.link).offset
  const requirements = {}

  let offset = verneed.offset
  const end = verneed.offset + verneed.size
  while (offset < end) {
    const count = u16(offset + 2)
    const fileName = nameAt(strtab, u32(offset + 4))
    const auxOffset = u32(offset + 8)
    const next = u32(offset + 12)

    const versions = requirements[fileName] ?? []
    let aux = offset + auxOffset
    for (let i = 0; i < count; i++) {
      versions.push(nameAt(strtab, u32(aux + 8)))
      const auxNext = u32(aux + 12)
      if (auxNext === 0) break
      aux += auxNext
    }
    requirements[fileName] = versions

    if (next === 0) break
    offset += next
  }
  return requirements
}

/** Every `GLIBC_x.y` version a file requires, newest first. */
export function glibcVersionsRequired(buffer) {
  const requirements = readVersionRequirements(buffer)
  if (requirements === null) return null
  const versions = new Set()
  for (const list of Object.values(requirements)) {
    for (const version of list) {
      const match = /^GLIBC_(\d+(?:\.\d+)*)$/u.exec(version)
      if (match) versions.add(match[1])
    }
  }
  return [...versions].sort((a, b) => compareVersions(b, a))
}

export function checkGlibcFloor(buffer, floor = DEFAULT_GLIBC_FLOOR) {
  const required = glibcVersionsRequired(buffer)
  // Not an ELF at all: a macOS Mach-O `.node` has no glibc requirements to exceed.
  if (required === null) return { elf: false, ok: true, floor, required: [], violations: [] }
  const violations = required.filter((version) => compareVersions(version, floor) > 0)
  return { elf: true, ok: violations.length === 0, floor, required, violations }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const floorIndex = args.indexOf('--floor')
  const floor = floorIndex === -1 ? DEFAULT_GLIBC_FLOOR : args[floorIndex + 1]
  const files = args.filter((arg, index) => !arg.startsWith('--') && index !== floorIndex + 1)
  if (files.length === 0) {
    console.error('usage: check-glibc-floor.mjs <file.node> [--floor 2.31]')
    process.exit(2)
  }

  let failed = false
  for (const file of files) {
    const result = checkGlibcFloor(readFileSync(file), floor)
    if (!result.elf) {
      console.log(`${file}: not ELF, skipped`)
      continue
    }
    if (result.ok) {
      console.log(`${file}: ok (needs at most GLIBC_${result.required[0] ?? 'none'}, floor ${floor})`)
    } else {
      failed = true
      console.error(`${file}: requires ${result.violations.map((v) => `GLIBC_${v}`).join(', ')}, above the ${floor} floor`)
    }
  }
  process.exit(failed ? 1 : 0)
}
