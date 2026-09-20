/**
 * The glibc floor check (PHASE-5 criterion 8).
 *
 * Tested against ELF files built byte by byte in this file, because there is no Linux
 * binary on a macOS developer machine and the check has to be trustworthy *before* CI
 * produces one. A synthetic ELF is also the only way to assert the failing case: no
 * shipped artifact is supposed to require GLIBC_2.34, so the interesting input is one
 * that cannot be obtained from a correct build.
 */

import { describe, expect, it } from 'vitest'
import {
  checkGlibcFloor,
  compareVersions,
  glibcVersionsRequired,
  readVersionRequirements
} from '../../../scripts/check-glibc-floor.mjs'

/**
 * Build a 64-bit little-endian ELF carrying one `.gnu.version_r` section.
 *
 * Deliberately minimal and structurally real: the section header table, the string
 * table the verneed entries point into, and the `Elf64_Verneed` / `Elf64_Vernaux`
 * linked lists with their byte-offset `next` fields. Those offsets are the part of
 * the format most likely to be read wrongly, so the fixture exercises them rather
 * than flattening the lists.
 */
function buildElf(libraries: Record<string, string[]>): Buffer {
  const strings: string[] = ['']
  const stringOffsets = new Map<string, number>()
  let stringSize = 1
  const intern = (value: string): number => {
    const existing = stringOffsets.get(value)
    if (existing !== undefined) return existing
    stringOffsets.set(value, stringSize)
    strings.push(value)
    stringSize += Buffer.byteLength(value, 'utf8') + 1
    return stringOffsets.get(value) as number
  }

  const entries = Object.entries(libraries)
  for (const [library, versions] of entries) {
    intern(library)
    for (const version of versions) intern(version)
  }

  const dynstr = Buffer.alloc(stringSize)
  {
    let cursor = 0
    for (const value of strings) {
      dynstr.write(value, cursor, 'utf8')
      cursor += Buffer.byteLength(value, 'utf8') + 1
    }
  }

  const VERNEED = 16
  const VERNAUX = 16
  const verneedSize = entries.reduce((total, [, versions]) => total + VERNEED + versions.length * VERNAUX, 0)
  const verneed = Buffer.alloc(verneedSize)
  {
    let base = 0
    entries.forEach(([library, versions], index) => {
      verneed.writeUInt16LE(1, base) // vn_version
      verneed.writeUInt16LE(versions.length, base + 2) // vn_cnt
      verneed.writeUInt32LE(stringOffsets.get(library) as number, base + 4) // vn_file
      verneed.writeUInt32LE(VERNEED, base + 8) // vn_aux: offset from this record
      const isLast = index === entries.length - 1
      verneed.writeUInt32LE(isLast ? 0 : VERNEED + versions.length * VERNAUX, base + 12) // vn_next

      let aux = base + VERNEED
      versions.forEach((version, versionIndex) => {
        verneed.writeUInt32LE(0, aux) // vna_hash
        verneed.writeUInt16LE(0, aux + 4) // vna_flags
        verneed.writeUInt16LE(versionIndex + 2, aux + 6) // vna_other
        verneed.writeUInt32LE(stringOffsets.get(version) as number, aux + 8) // vna_name
        verneed.writeUInt32LE(versionIndex === versions.length - 1 ? 0 : VERNAUX, aux + 12) // vna_next
        aux += VERNAUX
      })
      base += VERNEED + versions.length * VERNAUX
    })
  }

  const shstrtab = Buffer.from('\0.shstrtab\0.dynstr\0.gnu.version_r\0', 'utf8')
  const nameOf = (section: string): number => shstrtab.indexOf(`\0${section}\0`, 0) + 1

  const HEADER = 64
  const SECTION_ENTRY = 64
  const SECTION_COUNT = 4
  const shstrtabOffset = HEADER
  const dynstrOffset = shstrtabOffset + shstrtab.length
  const verneedOffset = dynstrOffset + dynstr.length
  const sectionTableOffset = verneedOffset + verneed.length
  const total = sectionTableOffset + SECTION_COUNT * SECTION_ENTRY

  const elf = Buffer.alloc(total)
  elf.write('\x7fELF', 0, 'latin1')
  elf[4] = 2 // 64-bit
  elf[5] = 1 // little endian
  elf[6] = 1 // version
  elf.writeUInt16LE(3, 16) // e_type: ET_DYN
  elf.writeUInt16LE(62, 18) // e_machine: x86-64
  elf.writeUInt32LE(1, 20) // e_version
  elf.writeBigUInt64LE(BigInt(sectionTableOffset), 0x28) // e_shoff
  elf.writeUInt16LE(HEADER, 0x34) // e_ehsize
  elf.writeUInt16LE(SECTION_ENTRY, 0x3a) // e_shentsize
  elf.writeUInt16LE(SECTION_COUNT, 0x3c) // e_shnum
  elf.writeUInt16LE(1, 0x3e) // e_shstrndx

  shstrtab.copy(elf, shstrtabOffset)
  dynstr.copy(elf, dynstrOffset)
  verneed.copy(elf, verneedOffset)

  const writeSection = (
    index: number,
    fields: { name: number; type: number; offset: number; size: number; link?: number }
  ): void => {
    const base = sectionTableOffset + index * SECTION_ENTRY
    elf.writeUInt32LE(fields.name, base)
    elf.writeUInt32LE(fields.type, base + 4)
    elf.writeBigUInt64LE(BigInt(fields.offset), base + 0x18)
    elf.writeBigUInt64LE(BigInt(fields.size), base + 0x20)
    elf.writeUInt32LE(fields.link ?? 0, base + 0x28)
  }
  writeSection(0, { name: 0, type: 0, offset: 0, size: 0 })
  writeSection(1, { name: nameOf('.shstrtab'), type: 3, offset: shstrtabOffset, size: shstrtab.length })
  writeSection(2, { name: nameOf('.dynstr'), type: 3, offset: dynstrOffset, size: dynstr.length })
  writeSection(3, {
    name: nameOf('.gnu.version_r'),
    type: 0x6ffffffe,
    offset: verneedOffset,
    size: verneed.length,
    link: 2
  })
  return elf
}

describe('version comparison', () => {
  it('orders dotted versions numerically, not lexically', () => {
    // The bug this guards: '2.9' > '2.34' as strings, so a lexical compare would pass
    // a binary requiring GLIBC_2.34 against a 2.9 floor.
    expect(compareVersions('2.34', '2.9')).toBeGreaterThan(0)
    expect(compareVersions('2.31', '2.31')).toBe(0)
    expect(compareVersions('2.4', '2.31')).toBeLessThan(0)
    expect(compareVersions('2', '2.0.0')).toBe(0)
  })
})

describe('reading .gnu.version_r', () => {
  it('walks both linked lists', () => {
    const elf = buildElf({
      'libc.so.6': ['GLIBC_2.14', 'GLIBC_2.17', 'GLIBC_2.34'],
      'libstdc++.so.6': ['GLIBCXX_3.4.21']
    })
    expect(readVersionRequirements(elf)).toEqual({
      'libc.so.6': ['GLIBC_2.14', 'GLIBC_2.17', 'GLIBC_2.34'],
      'libstdc++.so.6': ['GLIBCXX_3.4.21']
    })
  })

  it('picks out glibc versions, newest first, ignoring other version families', () => {
    const elf = buildElf({ 'libc.so.6': ['GLIBC_2.17', 'GLIBC_2.34'], 'libstdc++.so.6': ['GLIBCXX_3.4.21'] })
    expect(glibcVersionsRequired(elf)).toEqual(['2.34', '2.17'])
  })

  it('reports nothing for an ELF with no version requirements', () => {
    expect(readVersionRequirements(buildElf({}))).toEqual({})
  })

  it('is not fooled by a file that is not ELF', () => {
    // A macOS `.node` is Mach-O and has no glibc requirements to exceed; saying so is
    // different from saying "this file is fine", which is why the result carries `elf`.
    expect(readVersionRequirements(Buffer.from('not an elf file at all, really not'))).toBeNull()
    expect(glibcVersionsRequired(Buffer.alloc(8))).toBeNull()
  })
})

describe('the floor check', () => {
  it('passes a binary built against the floor', () => {
    const result = checkGlibcFloor(buildElf({ 'libc.so.6': ['GLIBC_2.17', 'GLIBC_2.31'] }), '2.31')
    expect(result).toMatchObject({ elf: true, ok: true, violations: [] })
  })

  it('fails the binary the 2.32-2.34 symbol move actually produces', () => {
    // `openpty` and `forkpty` became GLIBC_2.34 when libutil merged into libc. This is
    // exactly what a build on a current runner emits, and exactly what refuses to load
    // on Ubuntu 20.04 — green build, broken launch (orca #9902).
    const result = checkGlibcFloor(buildElf({ 'libc.so.6': ['GLIBC_2.17', 'GLIBC_2.32', 'GLIBC_2.34'] }), '2.31')
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['2.34', '2.32'])
  })

  it('treats a non-ELF file as nothing to check, not as a pass to brag about', () => {
    const result = checkGlibcFloor(Buffer.from('Mach-O would go here'), '2.31')
    expect(result).toMatchObject({ elf: false, ok: true })
  })

  it('moves with the floor it is given', () => {
    const elf = buildElf({ 'libc.so.6': ['GLIBC_2.34'] })
    expect(checkGlibcFloor(elf, '2.31').ok).toBe(false)
    expect(checkGlibcFloor(elf, '2.34').ok).toBe(true)
  })
})
