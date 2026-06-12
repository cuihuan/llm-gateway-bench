# 贡献指南

这是一个**严肃的评测工具**，公信力全压在数据的可溯源与可复现上。最重要的一条原则：

> **不臆造。每个数字要么是脚本黑盒拨测出来的，要么挂得出公开来源；不确定就记空（`null` / `—`），绝不编。**

这条原则不是口号——它被 `probe/data.test.mjs` 编码进 CI，无来源的 benchmark 分会让 `npm test` 直接失败。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `probe/probe.mjs` | 拨测器 CLI（`node probe/probe.mjs --help`），黑盒测 OpenAI 兼容端点 |
| `probe/metrics.mjs` | 纯判定函数（假流式 / CJK / needle / 模型回显 / usage / 价格价值…），全带单测 |
| `probe/aggregate.mjs` | 聚合 `data/results` + `annotations` + `prices` + `models` → `web/*.json` |
| `data/gateways.json` | 在测网关清单（PR 自助提交） |
| `data/models.json` | 模型评测数据集（官方标价 + 可溯源 benchmark） |
| `data/annotations/` | 网关信任/合规人工标注（带证据链接） |
| `web/` | 静态站点（排行榜 + 模型评测 + 行为体检 + 分析框架） |

## 跑测试

零依赖，Node ≥ 20：

```bash
npm test        # metrics / aggregate / prices / probe / data 契约
npm run aggregate && npm run serve   # 本地起站点看效果
```

push / PR 会自动触发 [`ci.yml`](.github/workflows/ci.yml) 跑同一套测试。

## 添加一个网关

PR 修改 [`data/gateways.json`](data/gateways.json)，每条至少包含：

- `id`（唯一）、`name`、`website`
- `baseUrl`（**必须 `http(s)://`**，OpenAI 兼容根，拨测器会打 `/v1/...`）
- `authEnv`（存 key 的环境变量名；key 只进 GitHub Secrets，**永不入库**，缺 key 的网关自动跳过、不算失败）
- `probeModels`（数组，挑 1–2 个便宜模型）、`pricingUrl`、`tags`

维护者在 Secrets 配好 key 后，它自动进入每 6 小时拨测。

## 添加 / 修正模型与价格

PR 修改 [`data/models.json`](data/models.json)。价格是**官方标价**（list price），每条标 `source`，本地/免费模型记 `0`。字段：`id`（唯一）、`name`、`vendor`、`input`、`output`（USD/1M，非负）、`kind`、`source`。

## 补 benchmark 分（最严格的部分）

往某模型加 `bench` 时，**必须**满足（否则 CI 红）：

- 至少一个数值分（`mmluPro` / `gpqa` / `swe` / `aime`），范围 0–100；
- `src`（来源名）+ `srcUrl`（**`http(s)` 链接**）+ `asOf`（采集日期）。

```json
"bench": { "mmluPro": 75.9, "gpqa": 59.1, "swe": 42.0,
           "src": "DeepSeek-V3 Technical Report",
           "srcUrl": "https://arxiv.org/abs/2412.19437", "asOf": "2024-12" }
```

查不到确切出处的分数，**就别加**——宁可表里记 `—`。完整、实时的对比请引用专门的聚合榜单（页面已外链 Artificial Analysis / LM Council / OpenCompass）。

## 补 / 纠正信任标注

PR 修改 [`data/annotations/`](data/annotations/)。政策类结论（数据留存、是否用于训练）`evidence` **必须是条款原文链接或 `null`**，不留空字符串；`channel.verify` ∈ `pass/fail/pending/baseline/none`，`status` ∈ `good/warn/bad/unknown`。维护者与某网关有利益关联时在 `disclosure` 披露。

## 几条红线

- **不做黑箱加权总分** —— 各维度独立成列，读者自己排序权衡；
- **不混算不同探测地域** —— gh-us 的延迟 ≠ 国内体感，按 region 分列；
- **改了逻辑就补单测** —— 判定函数都是纯函数，易测；
- 原始拨测数据逐次 commit 于 `data/results/`，全程可复现、可审计。

方法论细节见 [docs/methodology.md](docs/methodology.md)。
