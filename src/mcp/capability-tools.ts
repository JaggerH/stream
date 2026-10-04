/**
 * 把能力包的 `ToolDef` 挂进 `/api/mcp` 那个 `McpServer`。
 *
 * ## 必须走高层 `registerTool`，别改回 `Server.setRequestHandler`
 *
 * Stream 的 MCP 面是**高层** `McpServer`（`server.registerTool` 那套，`createMcpServer` 里
 * 几十个动词全在上面），它自己已经在 ListTools / CallTool 这对 schema 上装了 handler。
 * 拿**低层** `Server.setRequestHandler` 再 set 一次是**覆盖**不是叠加——后端全部工具当场从
 * `tools/list` 里消失，而 `tools/list` 照样 200、只是短了一截。实测过：那样改之后
 * `src/mcp/server.test.ts` 一次红 21 条。`server.test.ts` 里那条「挂上能力工具之后后端自己的
 * 工具一个都没少」就是这件事的守卫。
 *
 * ## 代价：参数得从 JSON-Schema 片段翻成 zod
 *
 * `ToolDef.parameters` 是逐属性的 JSON-Schema 片段（DSH 的 `ParameterSchemaSpec` 形状），
 * 高层 `registerTool` 只收 zod raw shape。所以有 `zodShapeFromParameters` 这一层。它是**纯
 * 函数**、单独测；翻不动的类型退回 `z.unknown()`（**不抛**：一个包用了没见过的参数类型，
 * 代价应该是"这一格的校验松了"，不是"整个包装不上"）。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolDef } from '../../shared/capability/types.ts'
import type { McpExtras } from './tool-catalog.ts'

/** 一条属性片段 → 一个 zod 类型（还没套 optional）。 */
function zodTypeOf(spec: Record<string, unknown>): z.ZodTypeAny {
  const enumValues = spec.enum
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((v) => typeof v === 'string')) {
    return z.enum(enumValues as [string, ...string[]])
  }
  switch (spec.type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'array': {
      const items = spec.items
      return z.array(items && typeof items === 'object' ? zodTypeOf(items as Record<string, unknown>) : z.unknown())
    }
    case 'object': {
      // 有 `properties` 就**递归翻内层**，别一律退成 `record`：退成 record 的代价不是"校验松了"，
      // 是**模型看不见内层字段叫什么**——导出的 JSON-Schema 里那一格只剩「一个对象」，
      // 一个 `{ query, limit }` 的入参对模型而言变成"随便塞点什么"，它只能猜。
      // 没有 `properties`（真的就是一张自由字典）才回落 record。
      const properties = spec.properties
      if (properties && typeof properties === 'object') {
        // 内层的必填名单走 JSON-Schema 自己那条 `required: string[]`；顶层那一份是 DSH 的
        // 「逐属性 `required: true`」标法。**两套文法都要认**：能力包的 `parameters` 顶层
        // 由 DSH 定形，而内层片段是包作者手写的普通 JSON-Schema。
        //
        // 两者共用 `required` 这个键，靠**值的类型**分辨（`true` vs 数组），所以同一个对象
        // 属性表达不了「自己必填 + 内层这几个也必填」。那是两套文法撞在一个键上的结果；
        // 真要两样都说，把这一格拆成两个属性。
        const names = Array.isArray(spec.required) ? spec.required.filter((v): v is string => typeof v === 'string') : []
        return z.object(shapeOf(properties as Record<string, Record<string, unknown>>, (key, s) => s.required === true || names.includes(key)))
      }
      return z.record(z.string(), z.unknown())
    }
    default:
      return z.unknown()
  }
}

/** 一层属性表 → zod raw shape。必填与否由调用方给的判据决定（两套文法见 object 那一格）。 */
function shapeOf(
  properties: Record<string, Record<string, unknown>>,
  isRequired: (key: string, spec: Record<string, unknown>) => boolean,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, spec] of Object.entries(properties)) {
    // `.describe()` 要**套在最外层**（optional 之后）：zod 把说明挂在被调用的那个节点上，
    // 挂在里层的话 `.optional()` 一包，导出 JSON-Schema 时那句说明就不见了——工具还在，
    // 只是模型看不到这个参数是干什么的。
    let t: z.ZodTypeAny = isRequired(key, spec) ? zodTypeOf(spec) : zodTypeOf(spec).optional()
    const description = spec.description
    if (typeof description === 'string' && description) t = t.describe(description)
    shape[key] = t
  }
  return shape
}

/**
 * `ToolDef.parameters` → `registerTool` 要的 zod raw shape。
 * `required: true` 的留成必填，其余 `.optional()`。
 */
export function zodShapeFromParameters(parameters: ToolDef['parameters']): Record<string, z.ZodTypeAny> {
  return shapeOf(parameters, (_key, spec) => spec.required === true)
}

/**
 * 把一组 ToolDef 登记进一个 `McpServer`。`execute` 抛错走 MCP 自己的 `isError` 通道——
 * 工具失败是一条**结果**，不是协议错误：让它变成协议错误，客户端看到的是连接层面的失败，
 * 模型连"这次调用为什么没成"都读不到。
 *
 * `extra.signal` 必须透传：客户端取消这次调用时靠它，断了的话表现是"它一直没回来"，静默。
 */
export function registerCapabilityTools(server: McpServer, defs: ToolDef[]): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: zodShapeFromParameters(def.parameters),
        ...(def.annotations ? { annotations: def.annotations } : {}),
      },
      async (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
        try {
          const value = await def.execute(args ?? {}, { signal: extra?.signal })
          return { content: def.output.render(args, value) }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }
        }
      },
    )
  }
}

/**
 * 给一份既有的 `McpExtras` 补上 `capabilityTools` 那一格，**不动原对象、也不拷贝它的值**。
 *
 * 为什么不是 `{ ...base, capabilityTools }`：`buildMcpExtras` 交回来的那份里有一批 **getter**
 * （`identify` / `extract` 这类按域可用性现算的格子）。spread 只拷贝**求值结果**——展开那一刻
 * 还没醒的容器会被永久算成不在，工具面上少几个动词且没有任何一处会喊（AGENTS.md 里为
 * `identify_speakers` 记过；同一形状此前在另一格上也犯过）。原型委托则是每次读都现走一遍
 * 原型链，getter 照常求值。
 */
export function withCapabilityTools(base: McpExtras, capabilityTools: () => ToolDef[]): McpExtras {
  const out = Object.create(base) as McpExtras
  Object.defineProperty(out, 'capabilityTools', { value: capabilityTools, enumerable: true })
  return out
}
