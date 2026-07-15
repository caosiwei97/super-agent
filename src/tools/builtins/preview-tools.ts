import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ToolDefinition, ToolExecutionContext } from '../../core/tool-registry.js'
import type { Workspace } from '../../core/workspace.js'
import { isPathWithin, isSensitivePath } from '../../security/sensitive-paths.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

export function createPreviewTools(workspace: Workspace) {
  let server: Server | undefined
  let serverPort: number | undefined

  const resolveAppRoot = () => {
    const root = workspace.resolveExisting('app')
    return root
  }

  const assertPreviewConstraints = (context: ToolExecutionContext, root: string, port: number) => {
    const constraints = context.constraints
    if (!constraints?.filesystemReadRoots?.some((allowed) => isPathWithin(allowed, root))) {
      throw new Error('执行约束不允许读取 app/ 目录')
    }
    if (constraints.allowLoopbackListen !== true
      || !constraints.loopbackListenPorts?.includes(port)
      || !constraints.networkHosts?.includes('127.0.0.1')
      || !constraints.networkPorts?.includes(port)) {
      throw new Error(`执行约束不允许监听 127.0.0.1:${port}`)
    }
  }

  const tool: ToolDefinition = {
    name: 'start_preview',
    description: '启动工作区 app/ 目录的静态预览服务器，需要用户审批',
    parameters: {
      type: 'object',
      properties: { port: { type: 'number', description: '端口号，默认 8080' } },
      required: [],
      additionalProperties: false,
    },
    getCapabilities: () => ['filesystem.read', 'process.execute'],
    getConstraints: (input) => {
      const { port = 8080 } = input as { port?: number }
      return {
        filesystemReadRoots: [resolveAppRoot()],
        networkHosts: ['127.0.0.1'],
        networkPorts: [port],
        allowLoopbackListen: true,
        loopbackListenPorts: [port],
      }
    },
    supportedConstraintKeys: [
      'filesystemReadRoots',
      'networkHosts',
      'networkPorts',
      'allowLoopbackListen',
      'loopbackListenPorts',
    ],
    isConcurrencySafe: () => false,
    execute: async ({ port = 8080 }: { port?: number } = {}, context) => {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return `非法端口: ${port}`
      let root: string
      try {
        root = workspace.resolveExisting('app')
        if (!(await stat(root)).isDirectory()) return '错误：工作区 app/ 目录不存在'
      } catch {
        return '错误：工作区 app/ 目录不存在'
      }
      assertPreviewConstraints(context, root, port)
      if (server) return `预览服务器已在运行 → http://localhost:${serverPort}`

      const candidate = createServer(async (request, response) => {
        try {
          if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed')
            return
          }
          const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
          const requestedPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname
          const filePath = resolve(root, `.${requestedPath}`)
          const relativePath = relative(root, filePath)
          if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
            response.writeHead(403).end('Forbidden')
            return
          }

          // The lexical check above blocks ../. realpath also blocks a symlink
          // inside app/ from serving files elsewhere in the workspace.
          const realFilePath = await realpath(filePath)
          const realRelativePath = relative(root, realFilePath)
          if (
            realRelativePath === '..' ||
            realRelativePath.startsWith(`..${sep}`) ||
            isAbsolute(realRelativePath)
          ) {
            response.writeHead(403).end('Forbidden')
            return
          }

          // Static preview is never a secret transport. Authorization to start
          // the process cannot be reused as authorization to serve credentials.
          if (isSensitivePath(realFilePath, workspace.root)) {
            response.writeHead(403).end('Forbidden')
            return
          }

          const content = await readFile(realFilePath)
          response.writeHead(200, {
            'Content-Type': MIME[extname(realFilePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(request.method === 'HEAD' ? undefined : content)
        } catch {
          response.writeHead(404).end('Not Found')
        }
      })

      await new Promise<void>((resolvePromise, reject) => {
        candidate.once('error', reject)
        candidate.listen(port, '127.0.0.1', resolvePromise)
      })
      server = candidate
      serverPort = port
      return `✓ 预览服务器已启动 → http://localhost:${port}`
    },
    dispose: async () => {
      if (!server) return
      const active = server
      server = undefined
      serverPort = undefined
      await new Promise<void>((resolvePromise, reject) => {
        active.close((error) => (error ? reject(error) : resolvePromise()))
      })
    },
  }

  return [tool]
}
