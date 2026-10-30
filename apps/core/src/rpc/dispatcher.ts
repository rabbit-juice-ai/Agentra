/**
 * 分发表与分发器已收敛到 packages/protocol（B4：handler 返回类型必须与 result schema 绑定）。
 * 这里保留转发，避免各调用点与测试的 import 路径发生变化。
 */
export {
  createDispatcher,
  defineMethod,
  type MethodTable,
  type RpcContext,
  type RpcMethodDef,
} from '@agentra/protocol'
