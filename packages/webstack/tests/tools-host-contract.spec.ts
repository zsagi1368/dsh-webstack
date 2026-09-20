/**
 * 真宿主装配冒烟（TC-B4-W1 验收 3；铁律 1 兑现，V2-contracts §5-1/项2 方法复用；
 * 32C/33C1 契约例先例形制）。F2 断点的教训正是「单测全绿、真宿主装配即抛」：
 * buildStatusTool 旧 output.schema 带根级 required 数组，违反 dsh-tools author
 * value-schema DSL，插件测试不注入 ctx.tools 分支未走，真实宿主 register 即抛。
 *
 * 本 spec import 主仓真物（非 fake 桩）：`zDSH-main/packages/core/tools/src/
 * index.ts:84` 导出的 assertSupportedJsonSchema / validateJsonSchemaValue /
 * defineTool（rc.2 世代源路径，主仓只读零写入）。路径耦合登记在案：依赖
 * zDSH-main 为 zDSH-plugins 的 sibling 目录（campaign 固定布局，BRIEF 锚）；
 * 主仓缺席/结构漂移 = 响亮红（throw），绝不静默 skip。
 *
 * 锁谱（双向判别力自证）：
 * 1. 正例·真装配：真 cordis Context + WebRuntime + ctx.tools 假面（复刻主线
 *    ToolsRuntime.register 的校验副作用，主仓 index.ts:1028-1050 节录——铁律 1
 *    「桩必须复刻真物校验副作用」）→ assembleWebstack 三工具注册全部通过 rc.2
 *    真 assertSupportedJsonSchema 不抛；
 * 2. 正例·语义等价：转换后 canonical schema 保留根级 required:['tier',
 *    'engines','cache']（per-property required:true 被 defineTool 提升，布尔位
 *    不残留）+ 真 execute() 输出过 rc.2 真 validateJsonSchemaValue 零违规、
 *    缺 cache 必违规（required 语义判别力）；
 * 3. 正例·两代 parity：同一 author spec 过 rc.2 defineTool（真宿主链——
 *    dsh-tools 在 tsdown neverBundle，运行期由宿主世代提供）与仓内 rc.1
 *    装配捕获产物深等（两代转换一致 + 本 spec 镜像夹具新鲜度双锁）；
 * 4. 负对照：旧根级 required 形状 (a) 过 rc.1/rc.2 defineTool 均必抛
 *    "…is not supported by the value schema DSL"（真宿主抛点原位复刻，V2 项2
 *    实机方法）；(b) 生旧形状直接过同一真 assertSupportedJsonSchema 必抛
 *    JsonSchemaError（判别消息在案：violation 源为 per-property 布尔 required
 *    落非 object 节点——rc.2 JSON-schema 校验器支持根级 required 数组本身，
 *    真宿主对旧形的拒绝发生在 defineTool DSL 层，两腿皆红=判别力自证）。
 *
 * 运行：`pnpm test:contract`（= vitest run --config vitest.contract.config.ts）。
 * 默认套件（include 仅 *.test.ts/*.test.tsx）不含本 spec——PluginCenter 32C
 * 先例同款隔离（独立 checkout 的 CI 无 sibling 主仓，不得连坐红）。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { defineTool as defineToolRc1 } from '@deepseek-ai/dsh-tools';
import WebRuntime from '@deepseek-ai/dsh-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleWebstack } from '../src/index.ts';

/** 主仓 dsh-tools barrel 的运行面子集（本 spec 只消费这些符号；主仓只读）。 */
interface MainToolsModule {
  assertSupportedJsonSchema(schema: unknown): void;
  validateJsonSchemaValue(schema: unknown, value: unknown, path?: string): string[];
  defineTool(options: unknown): {
    name: string;
    output: { schema: Record<string, unknown> };
  };
}

// tests → webstack → packages → WebStack → zDSH-plugins → zDSH，主仓=sibling zDSH-main。
const MAIN_TOOLS_URL = new URL(
  '../../../../../zDSH-main/packages/core/tools/src/index.ts',
  import.meta.url,
);

let main: MainToolsModule;

beforeAll(async () => {
  const mainPath = fileURLToPath(MAIN_TOOLS_URL);
  if (!existsSync(mainPath)) {
    throw new Error(
      `true-host contract needs the mainline clone at ${mainPath}; ` +
        'run this suite from a workspace that carries zDSH-main as the sibling ' +
        'of zDSH-plugins (fail loud, never skip)',
    );
  }
  // 真代码，一次 import，零桩复制（V2 §5-1 非 fake 铁律；主仓零写入）。
  main = (await import(pathToFileURL(mainPath).href)) as MainToolsModule;
}, 120_000);

/** 修后 status 工具 author spec 的镜像夹具（与 src/index.ts buildStatusTool 同源；
 * 漂移由「rc.2 转换产物 vs rc.1 装配捕获产物深等」断言兜住——夹具过期即红）。 */
const FIXED_STATUS_OUTPUT_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tier: { type: 'string', required: true },
    bridge: { type: 'string' },
    vertical: { type: 'string' },
    engines: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          state: { type: 'string', required: true },
          cooldownRemainingMs: { type: 'number' },
          lastCode: { type: 'string' },
        },
      },
    },
    cache: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        hits: { type: 'number', required: true },
        misses: { type: 'number', required: true },
        size: { type: 'number', required: true },
      },
    },
  },
};

/** 旧 F2 形状（956df1b src/index.ts:551-583 逐字节选）——负对照夹具。 */
const LEGACY_STATUS_OUTPUT_SPEC: Record<string, unknown> = {
  ...structuredClone(FIXED_STATUS_OUTPUT_SPEC),
  required: ['tier', 'engines', 'cache'],
};
// 旧形 cache 属性无 per-property required（当年由根级数组承载）——还原真形：
(LEGACY_STATUS_OUTPUT_SPEC.properties as Record<string, Record<string, unknown>>).cache =
  structuredClone(FIXED_STATUS_OUTPUT_SPEC.properties.cache);
delete (
  (LEGACY_STATUS_OUTPUT_SPEC.properties as Record<string, Record<string, unknown>>).cache as Record<
    string,
    unknown
  >
).required;

function legacyToolOptions(): Record<string, unknown> {
  return {
    name: 'web_backend_status',
    description: 'legacy F2 fixture (root-level required)',
    parameters: {},
    output: {
      schema: LEGACY_STATUS_OUTPUT_SPEC,
      render: () => [{ type: 'text', text: '' }],
    },
    async execute() {
      return {};
    },
  };
}

describe('真宿主装配冒烟：status 工具 schema 过 rc.2 真断言（TC-B4-W1 验收 3）', () => {
  it('正例：真装配（ctx.tools 在场）三工具全过真 assertSupportedJsonSchema；canonical schema 语义等价', async () => {
    const registered: Record<string, unknown>[] = [];
    const ctx = new Context();
    ctx.plugin(WebRuntime, {});
    (ctx as unknown as Record<string, unknown>).tools = {
      // 复刻主线 ToolsRuntime.register 的校验副作用（主仓 index.ts:1028-1050
      // 节录；铁律 1：桩必须复刻真物校验副作用，此处断言体=真函数本体）。
      register: (definition: Record<string, unknown>): (() => void) => {
        const name = definition.name as string;
        const output = definition.output as Record<string, unknown> | undefined;
        if (
          output === undefined ||
          typeof output !== 'object' ||
          typeof output.render !== 'function' ||
          (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')
        ) {
          throw new TypeError(`tool "${name}" must declare output { schema, render, … }`);
        }
        main.assertSupportedJsonSchema(output.schema); // ← rc.2 真断言（index.ts:84 导出）
        const timeoutMs = definition.timeoutMs as number | undefined;
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
        }
        if (name === 'run_code') {
          throw new Error('tool name "run_code" is reserved (RUN_CODE_NAME)');
        }
        registered.push(definition);
        return () => {};
      },
    };

    // 真实宿主路径：assembleWebstack → tools seam → register(buildStatusTool())。
    expect(() => assembleWebstack(ctx, {})).not.toThrow();
    expect(registered.map((d) => d.name)).toEqual([
      'web_backend_status',
      'web_batch_search',
      'web_history',
    ]);

    const status = registered.find((d) => d.name === 'web_backend_status')!;
    const schema = (status.output as Record<string, unknown>).schema as Record<string, unknown>;
    main.assertSupportedJsonSchema(schema); // 幂等复验：真断言直过不抛
    // 语义等价自证：per-property required:true 被 defineTool 提升到所属 object
    // 节点的根级 required 数组——顶层 ['tier','engines','cache'] 与旧根级数组
    // 键集一致；嵌套 object（cache/engines.items）各自获得子键 required 数组；
    // 任何节点上都不残留布尔 required 位（那正是 rc.2 校验器会拒的形状）。
    expect(schema.required).toEqual(['tier', 'engines', 'cache']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.tier!.required).toBeUndefined();
    expect(props.cache!.required).toEqual(['hits', 'misses', 'size']);
    const items = props.engines!.items as Record<string, unknown>;
    expect(items.required).toEqual(['id', 'state']);
    expect(schema.additionalProperties).toBe(false);

    // 真 execute 输出过 rc.2 真值校验：完整报告零违规；缺 cache 必违规。
    const execute = status.execute as (args: unknown, exec: unknown) => Promise<unknown>;
    const value = await execute({}, {});
    expect(main.validateJsonSchemaValue(schema, value)).toEqual([]);
    const withoutCache = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'cache'),
    );
    expect(main.validateJsonSchemaValue(schema, withoutCache).length).toBeGreaterThan(0);
  });

  it('正例：同一 author spec 过 rc.2 defineTool（真宿主 external 链）→ 真断言不抛，且与 rc.1 转换产物深等', async () => {
    // dsh-tools 在 tsdown neverBundle（external）→ 真宿主运行期由宿主世代（rc.2）
    // 提供 defineTool：此腿锁 rc.2 转换链与仓内 rc.1 世代 parity。
    const rc2 = main.defineTool({
      name: 'web_backend_status',
      description: 'mirror fixture (drift caught by deep-equal against the assembled capture)',
      parameters: {},
      output: {
        schema: FIXED_STATUS_OUTPUT_SPEC,
        render: () => [{ type: 'text', text: '' }],
      },
      timeoutMs: 10_000,
      async execute() {
        return {};
      },
    });
    main.assertSupportedJsonSchema(rc2.output.schema);

    // rc.1（仓内 devDep，装配实际调用面）对同一 spec 的转换产物——深等断言：
    // 两代转换一致 + 镜像夹具与 src/index.ts 现形不漂移（漂移即红）。
    const rc1 = defineToolRc1({
      name: 'web_backend_status',
      description: 'mirror fixture (drift caught by deep-equal against the assembled capture)',
      parameters: {},
      output: {
        schema: FIXED_STATUS_OUTPUT_SPEC,
        render: () => [{ type: 'text', text: '' }],
      },
      timeoutMs: 10_000,
      async execute() {
        return {};
      },
    } as never) as unknown as { output: { schema: Record<string, unknown> } };
    expect(rc2.output.schema).toEqual(rc1.output.schema);
  });

  it('负对照 (a)：旧根级 required 形状过 rc.1/rc.2 defineTool 均必抛 DSL 拒收（真宿主抛点原位）', () => {
    // V2-contracts 项2 实机方法复用：JsonSchemaError
    // "unsupported JSON schema: schema.required is not supported by the value schema DSL"。
    expect(() => defineToolRc1(legacyToolOptions() as never)).toThrowError(
      /is not supported by the value schema DSL/,
    );
    expect(() => main.defineTool(legacyToolOptions())).toThrowError(
      /is not supported by the value schema DSL/,
    );
  });

  it('负对照 (b)：生旧形状直接过同一真 assertSupportedJsonSchema 必抛（判别力自证）', () => {
    // 在案：rc.2 JSON-schema 校验器支持根级 required 数组本身；生旧形状被拒的
    // violation 源是 per-property 布尔 required 落在非 object 节点（tier/engines/
    // hits/misses/size…「required is not supported on type …」）。真宿主对旧形的
    // 第一抛点在 defineTool DSL 层（负对照 (a)）——两腿皆红，新旧判别成立。
    expect(() => main.assertSupportedJsonSchema(LEGACY_STATUS_OUTPUT_SPEC)).toThrowError(
      /unsupported JSON schema/,
    );
    // 修后形状（无根级数组、含 per-property 布尔位）同样不过 JSON-schema 校验器
    // ——author DSL 与 canonical JSON schema 是两个词汇表，真宿主只以转换后产物
    // 受检（正例腿已证）；此断言锁「不得把 author spec 直捅 register」的边界。
    expect(() => main.assertSupportedJsonSchema(FIXED_STATUS_OUTPUT_SPEC)).toThrowError(
      /unsupported JSON schema/,
    );
  });
});
