import { spawn } from 'node:child_process'
import { withSelfHeldBlockFd } from '../../src/execution/linux-self-held-block.js'

const marker = process.argv[2]
if (!marker) throw new Error('marker path required')

await withSelfHeldBlockFd('/usr/bin/mkfifo', new AbortController().signal, async (handle) => {
  const child = spawn(process.execPath, ['-e', [
    "const fs=require('node:fs')",
    'const value=Buffer.alloc(1)',
    'fs.readSync(3,value,0,1,null)',
    'fs.writeFileSync(process.argv[1],String(value[0]))',
  ].join(';'), marker], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', handle.fd],
  })
  if (!child.pid) throw new Error('blocked child did not spawn')
  process.stdout.write(`${child.pid}\n`)
  await new Promise<never>(() => {})
})
