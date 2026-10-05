# @mohou/jira-mcp

自托管 **Jira Server / Data Center** 的 MCP server。为一个具体约束而做:**Jira 8.5.7 没有 Personal Access Token**(PAT 从 8.14 才有),所以认证必须走 Basic Auth;而实例上插件多、自定义字段多,固定工具面覆盖不了。

跑起来是**一个进程、一个 MCP server、109 个工具**:

```
55  jira_*      核心实体(issue / comment / worklog / attachment / project / user
               / link / watcher / meta / agile)
54  zephyr *    Zephyr Scale(测试用例 / 文件夹 / 测试循环 / 执行 / 测试计划 / 附件 / 自动化结果)
```

```
Node >= 22.6
```

> **关于构建**:从 GitHub 克隆下来**不需要构建** —— 源码直接跑(Node 原生类型擦除)。但从 npm 装下来的包带的是 `dist/jira-server.mjs` 单文件 bundle:Node **不允许**擦除 `node_modules` 里 `.ts` 的类型
> (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),所以发布物必须是编译后的 JS。两条路径由 `bin/jira-server.mjs` 自动选择。

## 从 npm 安装

```bash
npx @mohou/jira-mcp          # 或 npm i -g @mohou/jira-mcp
```

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@mohou/jira-mcp"],
      "env": {
        "JIRA_BASE_URL": "https://jira.corp.com",
        "JIRA_USERNAME": "your.name",
        "JIRA_PASSWORD": "***",
        "ZEPHYR_ALLOW_INTERNAL_API": "true"
      }
    }
  }
}
```

## 从源码运行

```bash
npm install
JIRA_BASE_URL=https://jira.corp.com \
JIRA_USERNAME=your.name JIRA_PASSWORD='***' \
ZEPHYR_ALLOW_INTERNAL_API=true \
npm start
```

入口是 `bin/jira-server.mjs`(纯 JS 的版本守卫):Node 低于 22.6 会直接给出可读报错,而不是从 TypeScript 里抛一个语法错误。

接入任意 MCP 客户端:

```json
{
  "mcpServers": {
    "jira": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/jira-mcp/bin/jira-server.mjs"],
      "env": {
        "JIRA_BASE_URL": "https://jira.corp.com",
        "JIRA_USERNAME": "your.name",
        "JIRA_PASSWORD": "***",
        "ZEPHYR_ALLOW_INTERNAL_API": "true"
      }
    }
  }
}
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JIRA_BASE_URL` | — | 必填 |
| `JIRA_USERNAME` / `JIRA_PASSWORD` | — | **8.5.7 走这条**(Basic Auth) |
| `JIRA_PAT` | — | 8.14+ 才可用;设了就用 Bearer |
| `JIRA_READ_ONLY` | `false` | 统一只读开关,同时约束核心工具和 Zephyr |
| `JIRA_TLS_REJECT_UNAUTHORIZED` / `JIRA_SSL_VERIFY` | `true` | 自签证书设 `false` |
| `JIRA_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `JIRA_MAX_RETRIES` | `2` | 对 429/502/503/504 与网络错误的重试次数(尊重 `Retry-After`) |
| `JIRA_CONFIG_FILE` | `<项目>/jira.config.json` | 别名文件路径,可指向外部 |
| `ZEPHYR_ENABLED` | `true` | `false` 可整体关掉 Zephyr |
| `ZEPHYR_ALLOW_INTERNAL_API` | `false` | 开启后多 12 个工具(见下) |
| `ZEPHYR_DEFAULT_PROJECT_KEY` | — | Zephyr 工具的默认项目 |

### 错误信息是可执行的

失败的返回不是裸状态码,而是带着下一步动作:

```
400 Field 'customfield_20001' cannot be set. It is not on the appropriate screen...
 → 字段 'customfield_20001' 不在该项目/类型的 Screen 上,或字段名不存在。
   先用 jira_describe_create / jira_describe_edit 查看当前真正可填的字段。

401 → 认证失败。若该账号走 SSO/Crowd 且无本地密码,或实例开启了 CAPTCHA,Basic Auth 不可用。
404(插件路径) → 路径不存在。若这是插件接口,先确认插件已安装(可调 jira_list_plugins)。
```

## 为什么这样设计

### 1. 字段知识是运行时数据,不是代码

`customfield_20001` 在你们实例里是"部门"、值是 `{"id":"10101"}`,在别人实例里是别的字段。**把它写进代码就锁死了** —— 这正是大多数现成 MCP server 的死法。

所以写接口一律 `fields` 原样透传,字段的形状由两个"填空题"工具在运行时从 Jira 读出来:

```
jira_describe_create(project, type) → 创建时可填的字段 + 取值形态 + 可选值 + 必填性
jira_describe_edit(issueKey)        → 这个 issue 当前能改什么(已按工作流/屏幕过滤)
```

模型看到的实际输出:

```
项目 PROJ / 类型 Task — 创建时可填  可填 5 个字段(必填 2)

必填:
  summary                    string         → "文本"
  customfield_20001(部门)      option         → {"id":"..."}  可选项: 平台组(10101) | 基础架构组(10102)

选填:
  assignee                   user           → {"name":"username"}  可选项: alice(alice)
  customfield_20002(上线日期)    date           → "2026-01-01"

按上面的形态填好后调用: jira_create_issue({ fields: {...} })
```

写不进去的字段(attachment、issuelink 等)会被过滤掉,模型不用撞 400。管理员改字段、插件加字段,模板自动跟随,零代码改动。

### 2. 三层各管一件事,互不越界

| 层 | 管什么 | 例子 |
|---|---|---|
| `src/types.ts`(Zod 注册表) | 参数的**形状和用法** | `issueKey` 必须 `PROJ-123`;Server 用 `name` 不是 `accountId` |
| `tools.d/*.json` | **有哪些工具、打哪个端点** | Tempo 的 `/rest/tempo-timesheets/4/worklogs` |
| Jira meta 接口 | 字段有哪些、值怎么填 | `customfield_20001` 可选"平台组" |

`types.ts` 里的 `.describe()` 直接进模型看到的 JSON Schema,所以"Server 用 name"这类坑**写一次,所有引用它的工具都自动获得正确提示**。

### 3. 入参有类型,返回值也有

入参侧是 `src/types.ts` 的 `T`,返回值侧是对称的 `src/entity-types.ts` 的 `E` —— issue、comment、worklog、attachment、project、user、serverInfo、paged,以及 `testCase` / `testRun` / `testResult`。

```ts
jira_get_issue: defineTool({
  readOnly: true, returns: E.issue,     // ← 声明后成为 MCP outputSchema,并返回 structuredContent
  input: { key: T.issueKey, fields: T.fieldIds.optional() },
  run: ({ key, fields }) => jira('GET', `/issue/${key}`, { query: { fields: fields?.join(',') ?? '*all' } }),
}),
```

**只声明信封,不声明业务字段。** Jira 的响应字段随实例、插件、版本变化,所以实体类型用 `.passthrough()` 并只固定稳定部分(`id` / `key` / 数组字段名):

```jsonc
// jira_get_issue 的 outputSchema(模型实际看到的)
{ "type": "object", "required": ["id", "key", "fields"],
  "properties": { "id": {...}, "key": {...}, "fields": {"description": "...customfield_xxxxx..."} },
  "additionalProperties": true }        // ← 未声明的字段必须放行
```

两条硬约束(踩过才知道):

| 约束 | 原因 |
|---|---|
| **204 类工具不声明 `returns`** | update/delete/assign/transition 返回空响应,而声明了 outputSchema 就必须给 structuredContent —— 空 body 会让 MCP 结果校验直接失败 |
| **数组根的工具不声明 `returns`** | MCP 要求 outputSchema 的对象根;`/project`、`/field`、`/user/search` 返回数组,包一层就是对 API 撒谎 |

当前 109 个工具里 25 个带 `outputSchema`(我们的核心工具)。Zephyr 的 54 个来自 vendored 上游代码,自带 zod 校验与契约测试,其返回形状随实例变化,所以只在 `E` 里登记信封、不强加到上游工具上。

### 4. 8.5.7 兼容性有测试守着

Server 8.5.7 只有 REST API v2(加 Agile 1.0),**`/rest/api/3` 在它上面不存在**。`test/compat.test.mjs` 三道断言守住这条:

1. `src/` 里没有任何文件引用 `/rest/api/3`
2. `tools.d/*.json` 里没有
3. 跑一遍全部工具(读 + 写),断言 mock 收到的**每一个请求路径**都落在 `/rest/api/2/`、`/rest/agile/1.0/` 或已声明的插件前缀里

第 3 条上线当天就抓出了一个真 bug:附件上传绕过了路径解析,POST 到了 `/issue/...` 而不是 `/rest/api/2/issue/...`。

## 扩展

### 加一个工具(代码)

```ts
// src/entities/worklog.ts
jira_list_worklogs: defineTool({
  readOnly: true, desc: '列 issue 工时',
  input: { key: T.issueKey },
  run: ({ key }) => jira('GET', `/issue/${key}/worklog`),
}),
```

`run` 返回对象 → 自动 JSON 化;返回字符串 → 原样给模型;抛异常 → 变成 `isError`。没有别的约定。

### 加一个实体

新建 `src/entities/xxx.ts` 导出一个普通对象,在 `src/entities/index.ts` 数组合里加一行。

### 加一个插件(JSON,不用改代码)

```jsonc
// tools.d/plugins.json
"jira_tempo_worklogs": {
  "desc": "查 Tempo 工时",
  "readOnly": true,
  "params": { "from": "string", "to": "string", "projectKey": "projectKey" },  // ← 引用类型注册表
  "required": ["from", "to"],
  "method": "GET",
  "path": "/rest/tempo-timesheets/4/worklogs",
  "query": { "from": "{from}", "to": "{to}" }
}
```

`"{x}"` 整串占位 → 原样传值(保留类型);`"a{x}b"` → 字符串插值。**JSON 里定义的工具会覆盖代码里的同名工具**(后覆盖前)。

声明还支持 **`returns`**:引用 `src/entity-types.ts` 里的实体名(例如 `"returns": "paged"`),声明后 JSON 工具也会带 `outputSchema` 并返回 `structuredContent`——和代码里声明的工具完全一致。形状未知时用 `anyObject`(MCP 要求对象根,这是最宽松且诚实的声明)。

完整的 DSL 参考、校验规则、以及"怎么找到插件的 REST 路径"写在 [`tools.d/README.md`](tools.d/README.md);`tools.d/examples/` 里有可复制的模板(该目录**不会**被自动加载,有测试守着)。

**不确定插件端点时,先探一遍**(只发 GET,不写任何数据):

```bash
JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD=... npm run probe:paths
# 或指定路径:
JIRA_BASE_URL=... ... node scripts/probe-paths.mjs /rest/myplugin/1.0/thing
```

它对 Tempo / ScriptRunner / JSM / Zephyr Scale / Xray / Zephyr Squad / Structure / Insight 的常见路径逐个报告状态码:`404` 是没有,`405` 是路径存在但方法不对(脚本会自动补一次 POST),`200` 是可用的。把输出贴回来就能把可用的那些写成 `tools.d/` 声明。

### 加一个类型

在 `src/types.ts` 的 `T` 里加一项,代码和 JSON 立刻都能引用。

### 逃生口

装了没适配的插件,直接打它的 REST:

```
jira_request({ method: 'POST', path: '/rest/scriptrunner/latest/custom/foo', body: {...} })
```

`/rest/` 开头的路径原样透传,不会被拼成 `/rest/api/2/rest/...`。

## Zephyr Scale

Zephyr 是 **vendored** 进来的(不是依赖 npm 包),代码在 `src/entities/zephyr/`,注册到同一个 server。见 [NOTICE.md](NOTICE.md)。

- 默认 42 个工具;`ZEPHYR_ALLOW_INTERNAL_API=true` 再挂 12 个(`/rest/tests/1.0` 内部 API)
- 覆盖测试用例、文件夹、测试循环、执行结果、测试计划、附件、自动化/Cucumber 结果导入、BDD feature 导出

**为什么不用 JSON 声明 Zephyr**:它的关键操作不是"一次 REST 调用" ——
测试循环不可变(要建新循环再搬结果)、测试步骤要按 `id` 读-合并-写(否则静默丢步骤)、状态名大小写敏感且公开 API 不暴露、`executedBy` 要 Jira user key 而不是用户名。用 JSON 只能写出一个看起来完整、实际会静默失败的子集。

## 测试

```bash
npm run tools:describe      # 列出每个工具的输入/输出 schema 结构;--json 看完整 schema,用于检查插件声明
npm test                    # 离线契约 + 传输层测试(mock Jira,无网络)
npm run verify:vendor       # 用上游 Zephyr 自己的测试套件验证 vendoring 没改坏行为
npm run verify:live         # 对真实实例逐工具验证
npm run probe:paths         # 探测候选插件端点
npm run capture:instance    # 抓取真实实例的完整层级结构,用于扩展 schema
```

`verify:vendor` 从上游 pinned commit 拉干净源码,换成我们的 vendored 版本跑它的测试套件。当前结果 **17 个测试文件全绿、1175 个用例通过、0 失败**(跳过 2 个依赖未 vendoring 的打包文件)。详见 [NOTICE.md](NOTICE.md)。

`verify:live` 默认**只调用只读工具**(`readOnlyHint=true`),不产生任何写入,可以安全地对生产实例跑:

```bash
JIRA_BASE_URL=https://jira.corp.com JIRA_USERNAME=... JIRA_PASSWORD=... \
ZEPHYR_ALLOW_INTERNAL_API=true npm run verify:live
```

它会先探测版本和连通性,然后自动发现真实取值(项目 key、issue key、board id、sprint id),再逐个验证只读工具,最后写出 `verify-report.md`。

**写操作验证是可选的,而且要过两道闸**(`test/verify-writes.mjs`):

```bash
VERIFY_WRITE=1 VERIFY_PROJECT=PROJ \
JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD=... npm run verify:live
```

- 必须同时给 `VERIFY_PROJECT`,**没有默认值** —— 打错字不会写到别的项目去
- 全部操作发生在一个**新建的探针 issue** 上,最后在 `finally` 里删掉:创建/更新/指派、评论增改删、工时加删、watcher 加删、附件上传删除、remote link 创建、状态流转
- 唯一触及外部对象的动作是 link 到已有 issue,随后立即删除该 link(那个 issue 本身不被修改)

当前对 mock 的端到端结果:**39 通过 / 0 失败 / 15 跳过**(只读)+ 写阶段 25 步全通。

**"跳过"通常是插件没装或需要真实测试数据,不代表实现有问题。** 运行前会先做一轮**发现**:当前用户、项目、issue、附件 id、JSM 服务台 id、Zephyr 的用例/循环/计划 key、board、sprint。这些 id 决定了有多少工具能被真正验证——发现逻辑抽在 [`test/discover.mjs`](test/discover.mjs) 里并有独立测试,因为一旦它退化,验证覆盖面会静默缩水。

**一次运行拿全部结果**:加 `VERIFY_PROBE_PATHS=1`,验证结束后会顺便探测候选插件端点,并把结果写进同一份 `verify-report.md`:

```bash
JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD='***' \
ZEPHYR_ALLOW_INTERNAL_API=true VERIFY_PROBE_PATHS=1 npm run verify:live
```

单独探测也可以(`probe:paths` 会逐个报告候选路径的状态码:`200` 可用、`405` 路径存在但方法不对、`404` 没有)。候选清单在 [`test/probe-candidates.mjs`](test/probe-candidates.mjs),可自行增删。

### 抓取真实结构以扩展 schema

`npm run capture:instance` 会走一遍完整层级并**保存真实结构**,目的是让 `src/entity-types.ts` 的
schema 有据可依而不是靠猜。它采集:

- 一个 issue 的**全字段**(`fields=*all` + `expand=changelog,renderedFields,names,schema,transitions,editmeta`),
  以及它的评论、工时、附件、watcher、remote link、流转
- `createmeta` / `editmeta` 原始响应 → 哪些字段在创建/编辑屏幕上、是否必填、有哪些可选值
- 多个 issue 的采样(默认 3 条,`CAPTURE_LIMIT` 可调)→ **字段出现率**
- agile 层级:boards → sprints → sprint issues、backlog
- Zephyr 完整层级:test case(+ steps/attachments)→ test run(+ items/results/summary)→ test plan、
  文件夹树、状态选项、自定义字段定义、环境

产出三个东西,**安全性是刻意分开的**:

| 路径 | 内容 | 能否外传 |
|---|---|---|
| `capture/report.md` | 键名、类型、数组长度、出现/有值次数。**字段值全部抹掉** | ⚠️ 见下 |
| `capture/summary.json` | 同样内容的机器可读版 | ✅ |
| `capture/raw/*.json` | **原始 payload,含真实值** | ❌ 已在 `.gitignore` 里 |

`report.md` 里多 issue 采样会让你直接看到该留 `required` 还是必须 optional:

```
object
  id: string  *
  key: string  *
  fields: object  *
    summary: string  *
    customfield_20001: object        ← 没有 * = 只在 1/2 采样里出现,必须 optional
      value: string  *

| field | present | value shape |
| `summary` | 2/2 | string |
| `customfield_20001` | 1/2 | object{value} |
```

报告里**没有字段值**,但**有字段名**(真机上是业务术语)和采样的标识符(项目 key、issue key、board/sprint id、
Zephyr key)。如果你要把报告公开,加 `CAPTURE_REDACT=1`,标识符会变成占位符;字段名保留——没有它,字段 id
就没法对应到含义。

`*` = 该键在**每一次**采样里都出现(**只有一个样本时不会打星**,那只代表"只采了一次",不代表不稳定)。
**注意报告里有字段名**(真机上就是业务术语),值没有。接在 `verify:live` 后面跑也可以:加 `CAPTURE=1`。

**对 Jira 字段,"出现率"本身没有信息量**:每个 issue 都会带回全部字段键,值大多是 `null`。所以报告
额外统计 **`filled`**(非 null、非空的值),这才是"这个自定义字段到底有没有在用"的判据。参考实例上
339 个字段键里**只有 37 个有值**。

**报告会拿真实数据校验 schema**(`## Schema check` 段):每个捕获结果都映射到一个实体,逐个用
`src/entity-types.ts` 里的 schema 验证。所以 schema 不会悄悄漂移——假设错了就是一条 failed check,
而不是某次工具调用崩掉。改完 schema 可以离线复验,不用再开 VPN:

```bash
node scripts/capture-instance.mjs --check capture
```

## 发布

```bash
npm run build     # esbuild -> dist/jira-server.mjs(单文件,SDK 与 zod 保持 external)
npm publish       # prepack 会自动先 build
```

`dist/` 在 `.gitignore` 里(仓库不留构建产物),但 `files` 显式包含它,且 `prepack` 保证每次打包都是新构建。发布前的自检:

```bash
rm -rf dist && npm pack          # 模拟干净检出,确认 prepack 能构建出 dist
npm i -g ./mohou-jira-mcp-*.tgz  # 装到别处,确认真的能起
```

**为什么必须构建**:Node 对 `node_modules` 下的 `.ts` 拒绝类型擦除
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),源码形态装到别人机器上起不来。这是发布物必须带 JS 的唯一原因。

## 目标实例画像

[`docs/instance-profile.example.md`](docs/instance-profile.example.md) 是一份**示例/模板**(全是假数据),演示如何记录实测到的服务器版本、认证方式,以及**从自定义字段 schema 反推出的插件清单**(UPM 对普通账号不可读)。这份画像是工具面裁剪的依据:例如 `jira_tempo_worklogs` 被移除,就是因为目标机器上只有 Tempo Planner/Teams/Accounts,**没有 Tempo Timesheets**。

## 已知边界

- **JSON DSL 只能表达单次 REST 调用**。需要多步或聚合的逻辑写代码。守住这条,否则会退化成没人会用的 DSL。
- **Zephyr 的写操作在只读模式下是"注册但调用时拒绝"**(上游设计),不是从工具列表里消失。
- `jira_list_plugins` 需要管理员权限。实测:非管理员账号访问 `/rest/plugins/1.0/` 时,Jira Server 返回 **空的 406**(它用 HTML 错误页回应 `Accept: application/json`)。工具会依次尝试 `/rest/plugins/1.0/` 和 `/rest/plugins/1.0`,失败时给出"需要 Jira 管理员权限"的说明;`verify:live` 把这类失败记为 skip 而不是 fail。
- `tools.d/plugins.json` 里的插件示例**未经真实例验证**;`tools.d/examples/example-tempo-worklogs.json` 记录了一个反例:那个端点在真实 8.5.7 上返回 405,启用前必须先确认真实路径。
- 创建/更新受 **Jira 的 Screen 配置**约束 —— 字段不在对应 Screen 上会 400。这是 Jira 的限制,不是本项目的;`jira_describe_create` 返回的就是屏幕上的字段。
