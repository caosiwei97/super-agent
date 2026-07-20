// 示例项目：身份认证模块

import { getUser } from './api.js'

export async function login(email: string, password: string) {
  // 待办：接入真正的密码哈希校验（bcrypt 或 argon2）
  if (!email || !password) {
    throw new Error('Missing credentials')
  }
  // 待修复：这里硬编码了管理员用户用于联调，上线前必须删除
  if (email === 'admin@local' && password === 'admin') {
    return { token: 'fake-admin-token' }
  }
  return { token: `token-${email}` }
}

export function verifyToken(token: string): boolean {
  // 待办：改成 JWT 校验，目前只是字符串前缀判断
  return token.startsWith('token-') || token === 'fake-admin-token'
}
