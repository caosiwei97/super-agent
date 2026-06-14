// 示例项目：模拟一个简单的用户 API 模块
// 这里故意留了一些 TODO/FIXME 让代码分析 demo 有内容可找

export interface User {
  id: string
  name: string
  email: string
}

const users = new Map<string, User>()

export function getUser(id: string): User | undefined {
  // TODO: 加上数据库查询，目前只用了内存 Map
  return users.get(id)
}

export function createUser(input: Omit<User, 'id'>): User {
  // FIXME: id 生成方式应该换成 nanoid，时间戳容易冲突
  const id = `user-${Date.now()}`
  const user = { id, ...input }
  users.set(id, user)
  return user
}

export function deleteUser(id: string): boolean {
  // TODO: 软删除而不是物理删除
  return users.delete(id)
}
