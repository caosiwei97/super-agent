#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARCH_MISMATCH_ACTION,
  DEFAULT_ACTION,
  MUST_ALLOW_PROBES,
  MUST_DENY_PROBES,
  POLICY_FORMAT,
  POLICY_VERSION,
  TARGETS,
  resolveTargetPolicy,
} from './policy-v1.mjs'

const BPF_LD_W_ABS = 0x20
const BPF_JMP_JEQ_K = 0x15
const BPF_RET_K = 0x06
const SECCOMP_DATA_NR_OFFSET = 0
const SECCOMP_DATA_ARCH_OFFSET = 4
const SECCOMP_RET_KILL_PROCESS = 0x80000000
const SECCOMP_RET_ERRNO = 0x00050000
const SECCOMP_RET_ALLOW = 0x7fff0000
const EPERM = 1
const INSTRUCTION_BYTES = 8

const directory = dirname(fileURLToPath(import.meta.url))

function instruction(code, jt, jf, value) {
  const result = Buffer.alloc(INSTRUCTION_BYTES)
  result.writeUInt16LE(code, 0)
  result.writeUInt8(jt, 2)
  result.writeUInt8(jf, 3)
  result.writeUInt32LE(value >>> 0, 4)
  return result
}

function compile(architecture) {
  const policy = resolveTargetPolicy(architecture)
  const instructions = [
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET),
    // Matching architecture skips the kill instruction.
    instruction(BPF_JMP_JEQ_K, 1, 0, policy.auditArch),
    instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET),
  ]
  for (const syscall of policy.allowedNumbers) {
    // Match falls through to ALLOW; mismatch skips it and checks the next number.
    instructions.push(instruction(BPF_JMP_JEQ_K, 0, 1, syscall))
    instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW))
  }
  instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM))
  return Object.freeze({
    policy,
    instructions: instructions.length,
    bytes: Buffer.concat(instructions),
  })
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function parseArguments(argv) {
  let architectures = Object.keys(TARGETS)
  let output = join(directory, 'artifacts')
  let check = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') check = true
    else if (argument === '--arch') {
      const value = argv[++index]
      if (!value || !Object.hasOwn(TARGETS, value)) throw new TypeError('--arch is invalid')
      architectures = [value]
    } else if (argument === '--output') {
      const value = argv[++index]
      if (!value) throw new TypeError('--output requires a directory')
      output = resolve(value)
    } else {
      throw new TypeError(`unknown argument: ${argument}`)
    }
  }
  return { architectures, output, check }
}

async function compare(path, expected) {
  const actual = await readFile(path).catch(() => undefined)
  if (!actual || !actual.equals(expected)) throw new Error(`artifact drift: ${path}`)
}

async function main() {
  const { architectures, output, check } = parseArguments(process.argv.slice(2))
  const sourceFiles = [
    'build-profile.mjs',
    'policy-v1.mjs',
    'probe-v1.c',
    'release-probe-v1.c',
    'workspace-inspect-v1.c',
  ]
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [
    name,
    digest(await readFile(join(directory, name))),
  ])))
  const targets = []
  const files = []
  for (const architecture of architectures) {
    const artifact = compile(architecture)
    const filename = `policy-v1.${architecture}.bpf`
    const sha256 = digest(artifact.bytes)
    const shaFilename = `${filename}.sha256`
    files.push([filename, artifact.bytes])
    files.push([shaFilename, Buffer.from(`${sha256}  ${filename}\n`)])
    targets.push({
      architecture,
      auditArch: `0x${artifact.policy.auditArch.toString(16).padStart(8, '0')}`,
      artifact: filename,
      sha256,
      bytes: artifact.bytes.length,
      instructions: artifact.instructions,
      allowedSyscalls: artifact.policy.allowedSyscalls,
    })
  }

  const contract = {
    policyVersion: POLICY_VERSION,
    format: POLICY_FORMAT,
    defaultAction: DEFAULT_ACTION,
    architectureMismatchAction: ARCH_MISMATCH_ACTION,
    sourceSha256,
    mustAllowProbes: MUST_ALLOW_PROBES,
    mustDenyProbes: MUST_DENY_PROBES,
    targets,
  }
  const manifest = Buffer.from(canonicalJson({
    schemaVersion: 1,
    releaseStatus: 'candidate-linux-release-gate-required',
    contractSha256: digest(canonicalJson(contract)),
    ...contract,
  }))
  files.push(['manifest-v1.json', manifest])

  if (check) {
    await Promise.all(files.map(([name, contents]) => compare(join(output, name), contents)))
    return
  }
  await mkdir(output, { recursive: true })
  await Promise.all(files.map(([name, contents]) => writeFile(join(output, name), contents)))
}

await main()
