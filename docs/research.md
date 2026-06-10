# 调研：大模型评测网站与开源工具（2026-06）

> 本文是建仓前的调研沉淀，结论直接决定了本仓库的形态。TL;DR 见文末「定位结论」。

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
