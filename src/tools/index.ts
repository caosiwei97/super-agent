// tools/ 的统一出口。
// index.ts 只从这里导入，不直接深入子文件。
export { createBuiltinTools } from './builtins/index.js'
export { createToolSearch } from './meta/create-tool-search.js'
