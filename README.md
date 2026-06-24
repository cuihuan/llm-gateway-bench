# LLM Gateway Bench · 大模型网关评测

> **黑盒实测大模型网关/中转 API,不看声明看行为——帮你 5 秒看懂"我这台 vs 最好的,差在哪"。**
> *Black-box benchmark for LLM API gateways/relays. Don't trust claims, measure behavior — see in 5 seconds how your gateway compares to the best.*
>
> 🔗 在线 / Live: **https://cuihuan.github.io/llm-gateway-bench/** · 中英双语 / Bilingual · MIT

---

## ⚡ 30 秒 / TL;DR

**这是什么 / What it is** — 一个开源的网关评测**工具 + 知识库**:用你自己的 key 黑盒拨测任意 OpenAI 兼容网关,和"线上最好的"逐维度对比;附一套"怎么挑网关"的知识。
*An open-source gateway-benchmark **tool + knowledge base**: black-box test any OpenAI-compatible gateway with your own key, compare it to "the best" dimension by dimension, plus a guide on how to choose.*

**它替你回答一个问题 / The one question it answers**
> 我新接了一个网关,它到底行不行?比最好的**差在价格、速度、稳定、合规,还是缓存?**
> *I just plugged in a gateway — is it any good? Where does it lag the best: price, speed, stability, integrity, or caching?*

**一条命令自测 / Self-test in one command**
```bash
PROBE_KEY=sk-你的key npm run compare -- --model gemini-2.5-flash \
  --url https://your-gateway.com --name "我的网关" --price-in 0.2 --price-out 1.0
# → 一份自包含报告：差距体检卡(你 vs 最好) + 价格/速度/稳定/行为指纹/缓存。key 不出本机。
# → A self-contained report: gap card (you vs best) + price/speed/stability/fingerprints/cache. Keys never leave your machine.
```

### 🧠 选网关只看这几件事(按重要性) / What actually matters (in priority order)

| 维度 / Dimension | 看什么 / Check | 🚩 红旗 / Red flag |
|---|---|---|
| **1. 信任与合规 / Trust** | 给的是真模型吗?会跑路吗? / Real model? Will it vanish? | 模型回显不符、无主体/发票、便宜得反常 / wrong model echo, no entity/invoice, suspiciously cheap |
| **2. 价格 / Price** | 网关价 ÷ 官方价 = 倍率 / gateway price ÷ official | `<0.5×` 多为逆向渠道;虚报 token / sub-0.5× = likely reverse channel; inflated usage |
| **3. 稳定性 / Stability** | 30/7 天成功率、高峰是否变慢 / uptime, peak slowdown | uptime 抖动、高峰漂移 ≥2× / shaky uptime, peak TTFT drift ≥2× |
| **4. 速度 / Speed** | 首字延迟 TTFT、吞吐 tok/s / TTFT, throughput | 假流式(憋完一次性吐) / fake streaming |
| **5. 缓存 / Cache** | 重复 prompt 是否命中缓存 / prompt-cache hit | 重复请求不省钱 / no caching, repeats cost full price |
| *模型清单 / Catalog* | 有没有你要的模型与协议 / has the models you need | — |

> 口诀 / Rule of thumb:**先看信不信得过,再看贵不贵,然后才是快不快。** 便宜得反常 = 危险信号,务必配合"信任"一起看。
> *Trust first, price second, speed third. "Too cheap" is a danger sign — always read it alongside trust.*

---

## 🧭 新手选网关速查 / Choosing a Gateway (newbie guide)

**为什么用网关/中转 / Why a gateway** — 一个 key、一个 OpenAI 兼容端点访问多家模型;国内访问/支付更友好;有时更便宜或有兜底路由。
*One key, one OpenAI-compatible endpoint for many models; friendlier access/payment (esp. in CN); sometimes cheaper or with fallback routing.*

**它们其实分五类 / Five flavors (knowing which you want narrows the choice):**
1. **聚合器 / Aggregator** — 多家供应商、一套 API 一份账单(如 OpenRouter)。*Many providers, one API & bill.*
2. **中转站 / Relay** — 转售上游、常主打低价(本项目重点关注其**可信度**)。*Resold upstream, price-first — this project focuses on their trustworthiness.*
3. **网关/路由 / Gateway·Router** — 加策略/日志/限流/按请求选模型(LiteLLM、Portkey、Helicone)。*Adds policy, logging, per-request routing.*
4. **云模型商城 / Cloud model-mall** — 云厂商目录 + 企业管控(Bedrock 式)。*Cloud catalog with enterprise controls.*
5. **一手推理 / First-party inference** — 速度或价格优先(Groq、Together、SiliconFlow)。*Speed/price-first inference.*

**新手最容易踩的坑 / Pitfalls newbies hit**(也正是本项目要黑盒揪出来的 / what this project detects):
- 偷换模型 / 概率性降智 — 挂 Claude 的名卖便宜模型。*Model substitution / silent downgrade.*
- 虚报 token / 暗注 system prompt — 多收钱。*Inflated usage / hidden injected tokens.*
- 假流式 — 憋完整段再一次性吐,藏排队延迟。*Fake streaming hides queue latency.*
- 量化降智 — 路由到 INT4/FP4,中文先崩。*Quantized weights — CJK breaks first.*
- 上下文截断 — 长文本被悄悄裁短省成本。*Silent context truncation.*
- 跑路 / 无发票 — 低价引流→涨价→域名消失。*Exit scam / no invoice.*
- 隐藏成本 — 如 OpenRouter 充值 5.5% 手续费。*Hidden fees, e.g. OpenRouter's 5.5% credit fee.*

> 完整痛点 × 黑盒检测武器库见 [docs/research.md](docs/research.md);各维方法论见 [docs/methodology.md](docs/methodology.md)。
> *Full pain-points × detection toolbox in [docs/research.md](docs/research.md); per-dimension methodology in [docs/methodology.md](docs/methodology.md).*

---

## 🛠 这个项目给你什么 / What you get

三层,从"自己测"到"看榜单"到"学怎么判断" / Three layers — self-test → reference leaderboard → learn how to judge:

**① 工具 / Tools**(你自己跑,key 不出本机 / run locally, keys stay local)
- `npm run compare` — 你的网关 vs 别家/最好,出**差距体检卡**。*Your gateway vs others/best → a gap card.*
- `npm run longcontext` — 多长度 × 多深度 needle,看**上下文截断**热图。*Context-truncation heatmap.*
- `npm run matrix` — 经典模型 × 各网关横评(维护者在 CI 跑)。*Classic-model × gateway matrix.*

**② 在线榜单与探索器 / Live explorer**(参照基线,镜像下面的体系 / reference baseline)
打开 **https://cuihuan.github.io/llm-gateway-bench/**,自上而下:
- **帮我选 / Pick-for-me** — 勾你看重的(便宜/稳/快/合规),给透明推荐(逐维排名,不藏加权)。
- **速选 / Quick-rank** — 按优先级实时重排 + 协议/类型筛选 + "当前第一"高亮。
- **多视角 / Lenses** — 排行 / 价格 / 稳定 / 行为体检 / 简表,同一列表换列组。
- **差距体检 / Gap check** — "测我自己的网关",看和最好的差多少。
- **报告广场 / Report gallery** — 经典模型×网关横评、长文本、价格横评;可分享。
- **模型评测 / Model evals** — 选哪个模型最值(价格价值、权威 benchmark)。

**③ 知识库 / Knowledge base**
- [docs/methodology.md](docs/methodology.md) — 每个指标怎么测、口径定义。*How each metric is measured.*
- [docs/research.md](docs/research.md) — 用户痛点 × 检测武器库 × 同类站点调研。*Pain-points × detection × landscape.*
- [web/articles/](web/articles/) — 选型框架、偷换检测、计费陷阱、跑路风险等长文。*In-depth analysis articles.*
- [docs/COMPARE-TO-BEST.md](docs/COMPARE-TO-BEST.md)、[docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md) — 设计与数据组织。*Design & data model.*

---

## 🚀 快速开始 / Quick Start

```bash
# Node ≥ 20，零依赖 / zero deps
git clone https://github.com/cuihuan/llm-gateway-bench && cd llm-gateway-bench
npm test                                   # 单测 / unit tests

# A) 自测 + 差距体检：你的网关 vs OpenRouter / 别家
#    Self-test + gap check: your gateway vs OpenRouter / others
PROBE_KEY=sk-mine OPENROUTER_API_KEY=sk-or AIHUBMIX_API_KEY=sk-ah \
  npm run compare -- --model gemini-2.5-flash \
    --url https://your-gateway.com --name "我的网关" --price-in 0.2 --price-out 1.0 \
    --with openrouter,aihubmix
# → reports/<model>-<date>.html（自包含,可直接发人 / self-contained, shareable）

# B) 长文本上下文留存（多长度×多深度 needle）/ long-context retention
PROBE_KEY=sk-mine npm run longcontext -- --model gemini-2.5-flash \
  --url https://your-gateway.com --lengths 4000,16000,64000 --depths 10,50,90

# C) 本地看在线榜单 / serve the live dashboard locally
npm run serve                              # http://localhost:8080
```

每次拨测同时测 / Each run measures: TTFT & 吞吐(多采样分位数) · 成功率 · 价格倍率 · 工具调用转发 · 假流式 · 模型回显 · CJK 完整性 · 长文本截断 · usage 重算 · 提示缓存。
**红线 / Red line:key 只从环境变量读,绝不写进报告、绝不离开本机。**

---

## 📏 评测维度详解 / The Dimensions

每一维:**是什么 · 为什么重要 · 怎么测 · 红旗**。*Each: what · why · how measured · red flag.*

- **信任与合规 / Trust & integrity** — 渠道来源无法"声明证明",靠**行为指纹组合**黑盒画像:模型回显(揪偷换)、工具调用是否被剥离、假流式(逐 chunk 计时)、CJK 完整性(量化 tell)、上下文截断 needle、usage 重算(揪虚报);留存/训练/主体走条款标注 + 证据链接。🚩 任一指纹持续不过 / 便宜得反常 / 无主体发票。
  *Channel origin can't be "proven by claim" — profiled via a combination of black-box behavioral fingerprints.*
- **价格 / Price** — 网关价 ÷ 官方价 = 价格指数(官方价取 litellm 价格库),几何平均成倍率。🚩 `>1×` 偏贵;`<0.5×` 多为逆向渠道;charsPerToken 异常偏低 = 疑似虚报 token。
  *Gateway price ÷ official = price index. Sub-0.5× usually means a reverse/pirated channel.*
- **稳定性 / Stability** — 7/30 天滚动成功率、错误画像(限流 429 ≠ 故障 5xx ≠ 超时,分开看)、延迟漂移、按时段画像(高峰是否变慢)。🚩 高峰漂移 ≥2×、成功率抖动、封号潮断流。
  *Rolling uptime, error breakdown by type, peak-hour slowdown profiling.*
- **速度 / Speed** — 流式首字延迟 TTFT p50/p95、吞吐 tok/s。🚩 假流式(TTFT≈总延迟后一次性 dump)。
  *Streaming TTFT p50/p95 and throughput; fake-streaming detection.*
- **缓存 / Cache** — 同一长 prompt 连发两次,看第二次 usage 是否命中缓存(兼容 OpenAI/DeepSeek/Anthropic 三种口径)。🚩 重复 prompt 不省钱(不支持/不上报)。
  *Send the same long prompt twice; check if the 2nd reports cached tokens.*
- **模型清单 / Catalog** — 有没有你要的模型、协议覆盖(OpenAI / Anthropic)、模型数。
  *Does it carry your models; protocol coverage.*

---

## 🏗 它怎么工作 / How it works — 无服务器,数据即仓库 / serverless, data-as-repo

```
GitHub Actions (每 6h cron / every 6h)
  ├─ probe/probe.mjs     黑盒拨测每个网关×模型 / black-box probe each gateway×model → data/results/
  ├─ probe/prices.mjs    拉公开定价 / pull public pricing (litellm/synthorai/openrouter) → data/prices.json
  ├─ probe/matrix.mjs    经典模型×网关横评 / classic-model × gateway matrix → web/reports/matrix-*.json
  └─ probe/aggregate.mjs 聚合 / aggregate results + annotations + prices → web/data.json (+ price matrix)
        └─ web/*.html    静态渲染 / static render (GitHub Pages); browser & CLI share one render fn
```
- **无服务器、无数据库 / No server, no DB** — 原始数据逐次 commit,全量可审计、可复现。*Raw data committed per run; fully auditable & reproducible.*
- **密钥零入库 / Zero keys in repo** — key 只在 GitHub Secrets / 本地环境变量;缺 key 的网关标 skipped,不算失败。*Keys only in Secrets/env; missing-key gateways are skipped, not failed.*
- **不做黑箱总分 / No black-box score** — 各维独立成列;"帮我选/速选"把优先级映射到**透明的单维排序**,展示逐维排名。*Priorities map to transparent per-dimension sorts.*

---

## ➕ 用起来 / Use it

**加一个网关 / Add a gateway** — PR 改 [`data/gateways.json`](data/gateways.json)(填 `baseUrl`、`authEnv`、`probeModels`),维护者在 Secrets 配 key 后自动进入拨测。要进经典模型横评,再在 [`data/tracked-models.json`](data/tracked-models.json) 补该网关的模型别名。
*PR `data/gateways.json`; for the matrix also add model aliases in `data/tracked-models.json`.*

**分享报告 / Share a report** — 把 `report.json` 复制进 `web/reports/` 提 PR,或 `node scripts/publish-report.mjs <report.json>`(自动归档 + 校验无密钥)。
*Copy `report.json` into `web/reports/` (or use the publish script — it scans for leaked keys first).*

**本地高频记录器(macOS)/ Local hi-freq recorder** — `cp .env.example .env` 填 key → `./scripts/install-recorder.sh`(launchd 每 600s 拨测,补国内直连视角)。
*launchd timer probing every 600s for a local/CN network viewpoint.*

完整贡献规则与可信度铁律见 [CONTRIBUTING.md](CONTRIBUTING.md)。*Full rules in [CONTRIBUTING.md](CONTRIBUTING.md).*

---

## 🔭 同类与延伸阅读 / Landscape & references

我们的位置 / Where we sit:**用户视角、黑盒、可信度优先**地评测 OpenAI 兼容网关/中转——无服务器、数据即仓库。借鉴各家**思路**,实现独立。
*User-perspective, black-box, trust-first benchmarking of OpenAI-compatible relays — serverless, data-as-repo. We borrow ideas, build our own.*

**配套工具(同一作者)/ Companion tools (same author)** — 先选网关:[awesome-ai-gateway](https://github.com/cuihuan/awesome-ai-gateway)(精选清单 + 可复现成本评测 + 合规/安全评分卡);只想知道"某模型在不在线、多快":[modelprobe](https://github.com/cuihuan/modelprobe)(零依赖 Go 拨测,丢进 CI/cron)。本项目专注**用你自己的 key 黑盒实测网关行为**——三者构成"选 → 测行为 → 探可用"的评测工具套件。
*Pick a gateway with [awesome-ai-gateway](https://github.com/cuihuan/awesome-ai-gateway); check raw uptime with [modelprobe](https://github.com/cuihuan/modelprobe); this project measures gateway behavior black-box. Together: pick → benchmark → probe.*

- **模型/供应商 benchmark / Model & provider benchmarks** — [Artificial Analysis](https://artificialanalysis.ai)(质量/价格/速度跨供应商,金标准)、[LMArena](https://lmarena.ai)(人类偏好 Elo)、[OpenRouter Rankings](https://openrouter.ai/rankings)(真实流量)、[LiveBench](https://livebench.ai)、[BFCL 函数调用榜](https://gorilla.cs.berkeley.edu/leaderboard.html)。
- **保真/反欺诈 / Fidelity & anti-fraud** — [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)(同模型跨供应商工具调用对拍)、api-check(`system_fingerprint` 一致性)。
- **网关/路由生态 / Gateway & router landscape** — [OpenRouter](https://openrouter.ai)(聚合器,注意 5.5% 充值费)、[LiteLLM](https://github.com/BerriAI/litellm)(开源自托管,100+ 供应商)、[Portkey](https://portkey.ai)、[Helicone](https://helicone.ai)、Eden AI。
- **CN 中转评测 / CN relay reviews** — helpaio 等(本项目"帮我选/速选/多视角"信息架构的灵感来源)。
- **拨测/质量工具 / Probing & quality tools** — [llmperf](https://github.com/ray-project/llmperf)(TTFT/吞吐口径)、[promptfoo](https://github.com/promptfoo/promptfoo)(质量断言)、[litellm 价格库](https://github.com/BerriAI/litellm)(官方价数据源)。

---

## 公正性 / Fairness · 方法论 / Methodology

- 拨测脚本、探测 prompt、判定阈值、原始数据、聚合逻辑**全部开源**,任何人可用自己的 key 复现。*Everything open & reproducible with your own key.*
- 排行榜**不做黑箱加权总分**,各维度独立成列;政策类标注必须附**证据链接 + 日期**,缺失记「—」**不臆造**。*No black-box score; policy claims need a dated evidence link; missing = "—", never fabricated.*
- 维护者与某网关存在利益关联时,在条目中**披露**。*Conflicts of interest are disclosed inline.*

方法论摘要 — GitHub Actions 每 6h,固定 prompt 流式请求,每模型 3 采样报分位数,并发 ≤4(拨测不是压测);cron 抖动以真实时间戳为准。
*Methodology in brief — every 6h via GitHub Actions, fixed-prompt streaming requests, 3 samples/model reported as percentiles, concurrency ≤4 (this is dial-testing, not load-testing); real timestamps account for cron jitter.* 完整定义见 / Full definitions: [docs/methodology.md](docs/methodology.md)。

## License

MIT
