# 调研：大模型评测网站与开源工具（2026-06）

> 本文是建仓前的调研沉淀，结论直接决定了本仓库的形态。
> §一~三为建仓调研（2026-06-10）；§四~六为用户痛点与检测技术深调研（2026-06-11）。

## 一、评测网站盘点

| 网站 | 测什么 | 方法 | 开放数据 |
|---|---|---|---|
| [Artificial Analysis](https://artificialanalysis.ai) | 质量指数、价格($/1M)、TTFT、tok/s——**同一模型按供应商对比** | 持续自动拨测 500+ 真实端点，中位数+分位数，7/30/90 天窗口 | 有 Data API（免费 1k 次/天） |
| [LMArena](https://arena.ai)（原 LMSYS） | 人类偏好 Elo + 95% CI，分赛道（文本/WebDev/视觉/Agent…） | 众包盲测对战，Bradley-Terry 持续重算 | 周期性放出对战数据集 |
| [OpenRouter rankings](https://openrouter.ai/rankings) | 真实流量排名；**每个模型按供应商的 TTFT/吞吐/uptime** | 自有生产流量被动统计（滚动 5 分钟窗口） | 部分（模型元数据 API） |
| [BFCL（伯克利函数调用榜）](https://gorilla.cs.berkeley.edu/leaderboard.html) | 工具调用准确率 + 成本/延迟列 | AST 比对 + 可执行验证，版本钉死可复现 | 全开源（数据+代码+模型回复） |
| [LiveBench](https://livebench.ai) | 7 大类 21 任务质量分 | 每月换新题防污染，规则判分不用 LLM judge | 全开源 |
| [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier) | **同一开源模型在 12+ 供应商的工具调用保真度** | 固定 4000 条请求回放，以官方 API 为金标准对拍 | 代码 + 一半数据开源 |
| [LLMStatus.net](https://llmstatus.net) / [ModelUptime](https://modeluptime.com) / [LLM Overwatch](https://llmoverwatch.com) | 官方 API 可用性/延迟状态页 | 60s~10min 主动探测（部分多地域） | 否 |
| [GPT for Work tracker](https://gptforwork.com/tools/openai-api-and-other-llm-apis-response-time-tracker) | OpenAI/Anthropic/Gemini 响应时间 | 每 10 分钟、3 个地理位置、随机化 prompt 防缓存 | 否 |
| HF Open LLM Leaderboard | （已于 2025-03 退役） | 静态基准会饱和而死，**持续刷新的数据才活得下去** | 历史归档 |

**值得抄的 UI 模式**（来自做得最好的几家）：
1. 可排序排行榜表格：分位数指标（p50/p95）+ 置信区间，而不是单一平均值；
2. 价格 vs 速度/质量 **散点图**，Pareto 前沿一目了然（Artificial Analysis 招牌）；
3. 每端点 **over-time 时间序列**——把"一次性快照"变成"长期信任"，这正是数据积累的长线价值；
4. 每端点 uptime 条带图（OpenRouter 模型页样式）；
5. 可信度信号：公开探测 prompt 与频率、钉死版本、开放原始数据。

## 二、开源工具盘点

| 工具 | 状态 | 测什么 | 对本仓库的用法 |
|---|---|---|---|
| [llmperf](https://github.com/ray-project/llmperf)（Ray, 1.1k★） | **已归档** | TTFT/ITL/tok/s/错误率 | 方法论参考：固定 550 in / 150 out token、150 请求取分位数 |
| [llmperf-leaderboard](https://github.com/ray-project/llmperf-leaderboard) | **已归档** | 定期拨测→静态榜单 | 与本仓库目标完全相同的唯一先例，已死，空位就在这 |
| [AIPerf](https://github.com/ai-dynamo/aiperf)（NVIDIA, 361★） | 活跃 | TTFT/ITL/tok/s 高并发压测 | 压测形态，不适合低频拨测；指标定义可参考 |
| [guidellm](https://github.com/vllm-project/guidellm)（vLLM, 1.2k★） | 活跃 | 速率扫描 + SLO 分析 | 同上，面向自部署容量测试 |
| [promptfoo](https://github.com/promptfoo/promptfoo)（22k★, MIT） | 活跃 | 质量断言、多供应商对比，有官方 GitHub Action | **后期质量列**的首选：CI 原生 + 多供应商 |
| [llm-gateway-bench](https://github.com/taffy-owo/llm-gateway-bench)（3★, MIT） | 新 | 流式 TTFT/p95/成功率，YAML 多网关对比 | SSE 计时细节可参考 |
| [litellm](https://github.com/BerriAI/litellm)（50k★） | 活跃 | `model_prices_and_context_window.json` 是事实标准的开放价格库 | **价格列数据源** |
| uptime-kuma / arguslm / LMeterX / Helicone / Langfuse | 活跃 | 各类拨测/观测 | 都要常驻服务器，不符合"无服务器、静态榜单"形态 |
| lm-evaluation-harness / openai-evals | 活跃/维护态 | 学术质量基准 | 太重，与拨测无关 |

**工具结论**：
- 流式 TTFT/吞吐测量是已被解决无数次的 ~200 行问题（SSE 计时 + `stream_options.include_usage`），**自研最轻**；
- "GitHub Actions 定时拨测 + 时间序列存仓库 + 静态榜单"**目前没有活跃项目在做**；
- 多地域直连性探测（尤其国内直连）没有任何 LLM 工具在做——这是真正的差异化点（GH Actions 默认只有美国 runner，国内视角需补充自托管 runner 或边缘探针）。

## 三、定位结论（本仓库要做什么）

1. **形态**：无服务器。GitHub Actions 定时拨测 → 结果 JSON 提交回 `data/results/` → 静态页面渲染排行榜（GitHub Pages）。数据本身开源、可复现，随时间积累成壁垒。
2. **视角**：用户视角五维——直连性、稳定性、速度、价格、模型清单（详见 `methodology.md`）。
3. **差异化**：
   - 国内/多地域直连性探测（无人做）；
   - 中立性（OpenRouter 自卖自夸，Artificial Analysis 不测中转网关）;
   - 远期加"保真度"维度：K2 Vendor Verifier 式与官方 API 对拍，检测偷换模型/量化/截断上下文。
4. **工程红线**（来自调研的避坑）：cron 有 15min+ 抖动→记录真实时间戳；共享 runner 有邻居噪声→单次多采样取中位数、并发≤4；探测 prompt 公开 + 随机化防缓存。

---

## 四、深度调研：用户痛点 × 黑盒检测武器库（2026-06 补充）

> 渠道来源**无法直接"证明"**，本仓库的立场是 **行为指纹组合**：多个黑盒可测信号
> 共同给网关画像，不依赖网关自我声明。下面是从 linux.do / V2EX / 知乎 / 36kr /
> arXiv / GitHub 社区检测工具里提炼的痛点与对应的可落地检测方法。

### 4.1 用户痛点榜（按"影响选网关的程度"排序）

| # | 痛点 | 实锤数据 | 黑盒怎么测 | 本仓库状态 |
|---|---|---|---|---|
| 1 | **偷换模型/降智** | CISPA 审计：45.83% 端点指纹验证失败，性能偏差达 47.21%；ACM IMC：40%+ 端点指纹不符。手法：概率性降级、版本静默切换 | 周期性模型身份指纹（LLMmap 8 问 95%+ 准）+ 能力回归分，画成时间序列抓间歇性偷换 | 缺失（P1） |
| 2 | **偷 token/虚报 usage** | CISPA：付 $14.84 实得 $5.70-7.77（~38%）；IMC：某站实收超预期 62.8%；缓存读按全价计 | 本地 tokenizer 重算，比对网关报的 prompt_tokens/completion_tokens，偏差 >5% 报警 | 部分（已测 usage 上报率，未做重算比对，P0） |
| 3 | **跑路/无发票合规缺失** | V2EX「中转站的底裤」记录低价引流→涨价→服务恶化→域名消失；92+ 中转产品多数无企业注册/ICP | 存活时长/uptime 历史、死站墓地、主体/ICP/发票元数据列 | 部分（有 uptime 历史+人工标注，无墓地/存活时长） |
| 4 | **量化降智**（尤其聚合器路由到 FP4/INT4） | qwen-code PR#348 避开量化供应商；Roo-Code#11325 记录 CJK 输出在 Int4/FP4 退化为乱码 | CJK 输出完整性探针 + 编码质量探针 + 比对披露的量化等级 | 缺失（P2，需质量列） |
| 5 | **假流式** | 中转站把非流式响应缓存后伪装 SSE 回放，藏排队延迟 | 逐 chunk 计时：TTFT≈总延迟 + 内容在极小窗口内 dump | **已实现** ✓ |
| 6 | **上下文截断** | 中转站裁长上下文省上游成本；api-checker 用 canary+二分定位截断边界 | 多深度 needle-in-haystack（8K/32K/128K），与官方 API 对照 | 缺失（P1，单次成本 $0.4-1.2，周跑） |
| 7 | **高峰限速/动态倍率** | linux.do 实测「高峰期经常卡死」；某站 Claude Code 倍率 1.3→1.5 不通知 | **拨测的核心价值**：按时段画 TTFT/吞吐/成功率曲线，对比高峰 vs 低谷 | 部分（有时序，未按时段切片） |
| 8 | **封号波及** | Anthropic 封号潮清空账号池，~70% 因脏数据中心 IP；逆向 Sub2API 栈被批量风控 | 可用性/成功率事件时间线捕捉封号潮断流 + 标注渠道类型 | 部分（成功率时序在，无事件标注） |

### 4.2 黑盒检测武器库（按实现成本/优先级）

| 方法 | 协议 | 单次成本 | 来源 |
|---|---|---|---|
| **假流式检测** | 逐 chunk 计时，看 TTFT/E2E 比与 chunk 间隔分布 | $0（埋点即可） | LiteLLM#19909 |
| **usage 重算比对** | 固定 prompt 本地预算 token，比对网关上报，偏差>5% 报警；顺带查隐藏 system prompt 注入 | $0（搭车现有探针） | 36kr/知乎 |
| **K2 式工具调用对拍** | 200 请求子集对比 finish_reason F1 + JSON schema 合法率（官方 API 为金标准） | ~$1-3/模型 | K2-Vendor-Verifier |
| **LLMmap 身份指纹** | 8 条精心构造的 query，分类器识别模型版本，95%+ 准 | <$0.01/模型 | LLMmap, USENIX'25 |
| **MMD 模型相等性检验** | 每 prompt 采样 ~10 条补全，string-kernel MMD + 置换检验 vs 参考模型 | $0.1-0.5/探针 | Model Equality Testing, ICLR'25 |
| **logprob 漂移追踪** | 固定 prompt 取 1 token 的 logprob，追踪均值漂移检测微调/量化 | <1 分钱（仅 5/13 家开放 logprobs） | arXiv 2512.03816 |
| **能量距离行为指纹** | 每几小时采样固定 prompt 集（800 短请求），嵌入后比分布，e-value 聚合判变更 | 中（专为周期拨测设计） | arXiv 2603.19022 |
| **needle 上下文截断** | 多深度埋 UUID needle，硬截断表现为切点前确定性失败 | $0.4-1.2/模型（128K） | LLMTest_NeedleInAHaystack |

### 4.3 业内基线协议（拨测口径对齐）

- **Artificial Analysis**（金标准）：流式拨测，1k/10k/100k input + vision 四档负载，1k/10k/vision 每天 8 次（~每 3h），10 并发每天 1 次，100k 每周；指标取**trailing 72h 中位数**；token 统一归一化到 tiktoken o200k_base 保证跨供应商 $/token 与 tok/s 可比；固定 GCP us-central1 单 VM 出口。
- **OpenRouter**：被动统计真实流量，滚动 5 分钟窗口 p50/p75/p90/p99；uptime = 成功/总数**剔除用户错误(4xx)**——这个口径值得抄；按模型×供应商而非按 host 粒度。
- **thefastest.ai**：每天多地域(三 Fly.io 区)，warmup 连接去掉 TCP/TLS 建连延迟，1k in/20 out，best-of-3 丢排队离群。
- **llmperf**：550 in/150 out，Shakespeare 十四行诗拼接 prompt 强制长输出 + 数字转换正确性探针；单一 tokenizer 保证 tok/s 可比。
- **vLLM bench serve / AIPerf**：指标命名 `ttft/tpot/itl/e2el` + p50/p90/p99，Poisson 到达模拟真实负载——schema 命名直接抄。

### 4.4 可借鉴的社区中转站检测工具

- **api-check**（925★）：`system_fingerprint` 一致性对比检测掺假模型，纯前端 key 不出本地——信任维度协议直接抄。
- **ChannelMonitor**（活跃）：≥30 分钟探测间隔（成本/防滥用友好下限）、RPS/RPM 限流默认值、(channel,model) 粒度可用性语义。
- **all-api-hub**（4000★）：中转站类型识别清单可做我们的网关 taxonomy；跨站价格归一化喂价格矩阵。
- **api-key-tester**：四态 key 分类（valid/invalid/rate-limited/paid）——把 rate-limited 与 dead 分开，避免把网关误判为宕机。
- **Uptime Kuma**：push heartbeat 集成模式，让拨测结果能喂任意 Kuma 实例。

### 4.5 落地优先级（结论）

- **P0（零成本，搭车现有探针，立即做）**：假流式检测 ✓ 已做；usage 本地重算比对（揪虚报倍率/隐藏注入）。
- **P1（单次几分到几毛，周跑）**：模型身份指纹（LLMmap 式 8 问）防偷换；needle 上下文截断检测；按时段切片的高峰 vs 低谷曲线。
- **P2（需引入质量基线）**：量化/降智检测（CJK 完整性+编码质量）；K2 式工具调用对拍（已有单模型工具调用检查，扩成与官方对拍）。
- **UI**：页首痛点导引把"信得过吗"翻译成上面 8 条具体痛点 + 对应证据列；新增"自测指南"section 教用户用自己的 key 复现；信任评级文案强调"行为指纹组合，不看声明"。

---

## 四、用户痛点榜（按对选网关决策的影响力排序）

来源：linux.do / V2EX / 知乎 / 36kr 社区讨论 + CISPA 学术审计
[《Real Money, Fake Models》(arXiv 2603.01919)](https://arxiv.org/abs/2603.01919)。
每个痛点都标注了黑盒可测的取证方法与本仓库当前覆盖状态。

| # | 痛点 | 量化证据 | 黑盒取证方法 | 本仓库状态 |
|---|---|---|---|---|
| 1 | **偷换模型/降智**：挂着 Claude/GPT 的名卖便宜模型，或"概率降级"（部分请求路由到廉价模型）、版本静默切换 | CISPA：**45.83% 的中转端点过不了身份指纹测试**，性能偏差最高 47.21%；17 个影子 API 混进 187 篇学术论文 | 行为指纹组合（工具调用保真/流式真实性/延迟特征）+ 周期性身份指纹探测（[LLMmap](https://arxiv.org/abs/2407.15847)：8 条请求 >95% 准确率）+ 时序展示抓"间歇性偷换" | 部分：行为指纹已上线；身份指纹 P1 |
| 2 | **偷 token/虚报 usage**：私调计费倍率（1 个汉字记 3-4 token）、暗注系统提示词撑大 prompt_tokens、缓存价照原价收 | CISPA 实测：按官方价付 $14.84 实际只拿到 **$5
