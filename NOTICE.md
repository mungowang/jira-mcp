# NOTICE — 第三方代码

本项目包含 vendored(复制并入)的第三方代码。按 MIT 许可要求保留原始许可证与版权声明。

## Zephyr Scale MCP

| | |
|---|---|
| 来源 | https://github.com/vilaabo/zephyr-scale-mcp |
| 包名 | `zephyr-scale-mcp` (npm) |
| 版本 | 1.0.0 |
| 纳入的 commit | `9c43dc5080f776f69ef7f7a25222833e79347057` (2026-08-01) |
| 许可证 | MIT — 见 [`src/entities/zephyr/LICENSE`](src/entities/zephyr/LICENSE) |
| 位置 | `src/entities/zephyr/`(原 `src/`,不含原 `src/index.ts` 入口) |

上游是一个独立的 MCP server(自带 `McpServer` + `StdioServerTransport` 启动逻辑)。本项目把它**作为工具集**注册进同一个 `McpServer` 实例,因此不启动第二个进程。

### 施加的改动(更新上游时需重放)

1. **删除原入口** `src/index.ts` —— 它会自行 `main()` 并连接 stdio。改由 [`src/entities/zephyr/register.ts`](src/entities/zephyr/register.ts) 调用其 `loadConfig()` + `registerAllTools(server, cfg)`。

2. **相对 import 的 `.js` 后缀改为 `.ts`** —— 上游为 `tsc`/`tsup` 编译设计,而本项目直接用 Node 原生类型剥离运行,不设构建步骤:

   ```bash
   find src/entities/zephyr -name '*.ts' -print0 \
     | xargs -0 sed -i '' -E "s|(from '(\.\.?/)[^']*)\.js'|\1.ts'|g"
   ```

   注意:包路径 `@modelcontextprotocol/sdk/server/mcp.js` 的 `.js` **必须保留**,不要一并替换。

3. **`ZephyrApiError` 去掉 TypeScript 参数属性**(`src/entities/zephyr/http.ts`)—— `constructor(readonly status: number, ...)` 在 Node strip-only 模式下报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,改为显式字段声明 + 构造函数体内赋值。语义不变。这是全项目唯一需要改语法的地方(已确认无 TS `enum` / `namespace` / decorator)。

4. **新增 `register.ts`** —— 本项目自己的适配层:Zephyr 未配置时静默跳过;把 `JIRA_READ_ONLY=true` 映射为 `ZEPHYR_READONLY=true`,使只读开关统一。

上游的其他行为(重试与 `Retry-After` 退避、密钥脱敏、错误提示、内部 API 开关、只读判定)保持原样。

### 上游测试

**已用上游自己的测试套件验证过 vendoring 没有改坏行为**,可重放:

```bash
npm run verify:vendor
```

脚本从上游 pinned commit 拉一份干净源码,把 `test/` 换成上游的,再把被测源码替换为我们的 vendored 版本,运行 vitest。

实测结果:

```
Test Files  17 passed  (18)
     Tests  1175 passed | 13 skipped  (1188)
```

唯一跳过的 2 个文件是 `version.test.ts` 和 `docsConsistency.test.ts` —— 它们读 `README.md` / `server.json` / `src/index.ts`,这三个文件有意未纳入 vendoring(入口改为 `register.ts`)。**没有任何行为测试失败**,包括被改写过参数属性的 `test/http.test.ts`(110 个用例)。

上游其余 13 个 skipped 用例来自其自身的 opt-in 开关(如 `ZEPHYR_E2E`),属正常。

## 其余代码

`src/jira.ts`、`src/tool.ts`、`src/types.ts`、`src/jsonTools.ts`、`src/describe.ts`、`src/aliases.ts`、`src/entities/`(除 `zephyr/`)为本项目原创。
