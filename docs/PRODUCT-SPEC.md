# 产品重构规格（PRODUCT SPEC）· llm-gateway-bench

> 本文是重构的总规格。定位、架构、数据契约、盈利、路线图都以本文为准；
> 实现与 PR 必须对齐本文，偏离要先改本文再改代码（spec 原则）。
> 草拟于 2026-06-23。它**不推翻**现有拨测引擎与单测，而是在其上加产品层。

## 0. 一句话

把项目从"维护者替你测好的**榜单**"翻转为"任何人都能自测的**工具** + 可分享的**报告平台**"，
公共榜单退居为**权威参照基线**，并以付费托管拨测 / 报告托管 / 封装各厂商 SDK 变现，
长期通过报告 footer 引流到主项目。

## 1. 要解决的痛点（按用户原话）

1. **接入网关没法测**：要接一个新网关 / 中转，没有顺手的工具横向比一比（vs OpenRouter vs 别家）。
   → 交付**自助对比工具**：指定多个目标 + 自己的 key，一把跑全套黑盒，出并排对比。
2. **缺好的评测报告**：价格、长文本等维度缺一份可信、可复现、能分享的报告。
   → 交付**便携报告**：自包含 HTML + 结构化 JSON，本地生成、可公开到广场。
3. **报告可分享**：用户愿意分享就能 share 到平台，别的用户能查看。
   → 交付**报告广场**：分享报告即一份文件（数据即仓库），静态页渲染；后期加上传端点。

## 2. 两根产品柱子

### 柱子 A · 工具（self-serve tool）
- 命令：`gwbench compare`（实现为 `probe/compare.mjs`，npm script `compare`）。
- 输入：一份 compare spec —— 多个目标 `{name, baseUrl, authEnv, model}` + 逻辑模型标签。
- 行为：对每个目标跑**现有全套黑盒探针**（连通性、流式 TTFT/吞吐多采样、工具调用、
  假流式、模型回显、CJK 完整性、长文本 needle），复用 `probe.mjs` 抽出的 `probeGateway()`。
- 产出：
  - `report.json` —— 结构化对比结果（schema 见 §4），可被广场/平台 ingest；
  - `report.html` —— **自包含**单文件（内嵌数据 + 样式），file:// 直接打开，可发给别人。
- 红线：**key 只存环境变量、绝不入报告、绝不出本机**（隐私是对国内用户的核心卖点）。

### 柱子 B · 报告（report platform）
- **公共基线报告**：维护者 6h cron 拨测产出的榜单（现状）继续，作为自测的对照基线。
- **用户分享报告**：用户本地生成 → 选择公开 → 落为 `web/reports/<id>.json` 文件
  （Phase 2 走 PR；Phase 4 走上传端点），静态广场页 `web/reports.html` 列表 + 详情渲染。
- **报告分类**（顶层导航与广场筛选维度）：
  价格 · 长文本 · 稳定性 · 合规与安全 · 行为指纹（偷换/假流式/截断）。

## 3. 架构（保持"无服务器、数据即仓库"，按需加薄后端）

```
本地（用户的机器，自己的 key）
  gwbench compare  ──►  report.json + report.html        ← 柱子 A，纯本地，零后端
        │  （用户选择分享）
        ▼
web/reports/<id>.json  ──►  web/reports.html 广场静态渲染  ← 柱子 B，数据即仓库
        ▲
        │  Phase 4：薄上传端点（Cloudflare Worker / Vercel + KV）+ 支付
维护者 cron（现状）──► data/results/ ──► aggregate ──► web/data.json ──► 榜单（权威基线）
```

- Phase 1–3 **完全无服务器**，可立即上线；
- Phase 4 才引入薄后端（仅为"上传分享 + 支付"），不破坏前三阶段的纯静态形态。

## 4. 报告数据契约（report.json schema v1）

```jsonc
{
  "schema": "gwbench-report/1",
  "kind": "compare",                 // compare | longcontext | stability | ...
  "generatedAt": "2026-06-23T..Z",
  "tool": { "name": "gwbench", "version": "0.2.0" },
  "model": "gpt-4o-mini",            // 被对比的逻辑模型
  "region": "local-cn",              // 探测视角标签（PROBE_REGION）
  "samplesPerTarget": 3,
  "targets": [                       // 每个被测目标一项
    {
      "name": "OpenRouter", "host": "openrouter.ai",
      "ttftMs": { "p50": 510, "p95": 880 }, "tokensPerSec": 47.2,
      "successRate": 1, "toolCall": true, "burstStream": false,
      "modelEcho": true, "cjk": true, "needle": true,
      "usage": { "promptTokens": 21, "charsPerToken": 3.8 },
      "error": null
    }
  ],
  "comparison": {                    // 由 buildComparison() 纯函数算出
    "fastestTtft": "OpenRouter",
    "highestThroughput": "...",
    "flags": [ { "target": "...", "flag": "burstStream", "severity": "warn" } ]
  }
}
```

- key、Authorization、baseUrl 的私有部分**不得**进入报告（只留 host）。
- `comparison` 不做黑箱加权总分；只给"谁最快/最值/谁触发了哪些红旗"的客观派生。

## 5. 盈利模式（与产品柱子对齐）

| 层 | 免费 | 付费 |
|---|---|---|
| 工具 | 本地跑、用自己的 key、无限次 | —— |
| 托管拨测 | —— | **我们用自己的 infra/key 跑贵活**（128K 长文本 needle、K2 式与官方对拍、模型身份指纹），用户不烧自己 token、不用配环境 |
| 报告托管 | 公开分享到广场 | **Pro 报告**：私有/带品牌、定时复测、变更告警 |
| 统一客户端 | —— | **封装各厂商 SDK** 的统一 benchmark 客户端（国内用户一套接口横评多家），按 license / 调用量计费 |
| 引流 | 每份报告 footer + CTA → 主项目 | —— |

## 6. 路线图（每阶段可独立上线、可测、可提交）

- **Phase 0 · 规格**：本文。✅
- **Phase 1 · 工具 MVP**：抽 `probeGateway()`；`compare.mjs` 对比运行器；
  `report.mjs` 纯函数（`buildComparison` + `renderReportHtml`）+ 单测；`npm run compare`。✅
- **Phase 2 · 报告广场**：`web/reports.html` 静态渲染 `web/reports/*.json`（iframe srcdoc 复用
  `renderReportHtml`，与 CLI 像素一致）；`scripts/publish-report.mjs` 归档+清单；导航接入；范例报告。✅
- **Phase 3 · 长文本报告**：`longcontext.mjs` 多长度×多深度 needle 热图，kind=longcontext
  复用报告广场；`npm run longcontext`；范例报告。✅
- **Phase 4 · 网站与变现脚手架**：`pricing.html` 四层定价（自助免费/托管拨测/Pro 托管/封装 SDK）；
  首页自助对比 CTA。✅（脚手架）
  - **Phase 4b · 分享与支付（待定后端）**：一键上传端点 + 广场提交流；接入支付通道。⏳ 需定后端架构。
- **Phase 5 · 引流**：报告/榜单/定价页 CTA 深链到主项目；分享卡片 OG 图。⏳ 需主项目 URL（pricing.html 已留占位）。

## 7. 不变量（工程红线，沿用现状并扩展）

- 纯函数 + 单测：所有判定/聚合/报告构建逻辑放纯函数，必须有单测（沿用 `probe/*.test.mjs`）。
- 单一来源：上线算法 == 被测算法（如 `web/calc.mjs` 被浏览器与单测共用）。
- key 零入库 / 零入报告：只认环境变量，报告只留 host。
- 不做黑箱总分：各维度独立成列；唯一派生量是价格指数与"谁最快/最值"。
- 可复现：探针 prompt、阈值、原始数据公开，随机化防缓存。
