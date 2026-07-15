import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

const MAX_SECCOMP_PROFILE_BYTES = 1024 * 1024

export class SeccompProfileUnavailableError extends Error {
  override readonly name = 'SeccompProfileUnavailableError'
}

export class SeccompProfileIntegrityError extends Error {
  override readonly name = 'SeccompProfileIntegrityError'
}

async function sha256(handle: FileHandle) {
  const metadata = await handle.stat()
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SECCOMP_PROFILE_BYTES) {
    throw new SeccompProfileIntegrityError('seccomp profile 大小或类型非法')
  }
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < metadata.size) {
    const length = Math.min(buffer.length, metadata.size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead <= 0) throw new SeccompProfileIntegrityError('seccomp profile 读取不完整')
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest()
}

/** Open a fresh seccomp program descriptor for one bwrap spawn and always close it. */
export async function withSeccompProfileFd<T>(
  path: string,
  expectedSha256: string,
  execute: (descriptor: number) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new SeccompProfileIntegrityError('seccomp profile SHA-256 配置非法')
  }
  let profile
  try {
    profile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new SeccompProfileUnavailableError('seccomp profile 无法打开', { cause: error })
  }
  try {
    const actual = await sha256(profile)
    const expected = Buffer.from(expectedSha256, 'hex')
    if (!timingSafeEqual(actual, expected)) {
      throw new SeccompProfileIntegrityError('seccomp profile SHA-256 不匹配')
    }
    return await execute(profile.fd)
  } finally {
    await profile.close()
  }
}
