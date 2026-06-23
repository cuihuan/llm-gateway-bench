# LLM Gateway Bench · 大模型网关评测

> An open, user-perspective, continuously-running benchmark for LLM API gateways & models.
> 一套完整评测集，两层回答两个问题：
> **① 选哪个模型最值**（模型层：价格价值 · 权威 benchmark · 分场景 · 质量性价比）·
> **② 走哪个网关靠谱**（网关层：合规安全 · 价格 · 稳定性，全部黑盒拨测、不看声明）。

> 重构方向见 [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md)：从"维护者替你测好的榜单"
> 翻转为"任何人都能自测的**工具** + 可分享的**报告平台**"，公共榜单退为权威参照基线。

## 自助对比：测你自己的网关（`gwbench compare`）

要接一个新网关 / 中转，没法横向比一比？这就是那个工具。同一个逻辑模型，把
**你自己的网关**和 OpenRouter、AiHubMix 等放一起，一把跑完整套黑盒拨测，产出
一份**自包含、可分享的报告**（`report.html` + `report.json`）。**key 只从环境变量读，
绝不入报告、绝不出本机。**

```bash
PROBE_KEY=sk-你的key OPENROUTER_API_KEY=sk-or AIHUBMIX_API_KEY=sk-ah \
  npm run compare -- --model gemini-2.5-flash \
    --url https://my-gateway.com --name "我的网关" --price-in 0.2 --price-out 1.0 \
    --with openrouter,aihubmix
# → reports/gemini-2.5-flash-<日期>.html（自包含，可直接发给别人）
#   测项：TTFT/吞吐多采样 · 成功率 · 价格与倍率(÷官方价) · 工具调用 · 假流式 · 模型回显 · CJK · 长文本截断 · usage 指纹
#   登记网关的价格自动取自 data/prices.json；自建网关用 --price-in/--price-out 让它也进价格对比。
```

报告可公开到**报告广场**（[web/reports.html](web/reports.html)）：把 `report.json` 复制进
`web/reports/` 提 PR，或 `node scripts/publish-report.mjs <report.json>` 自动归档 + 更新清单
（发布前自动校验无密钥泄漏）。广场用与 CLI 完全相同的渲染逻辑呈现，分享报告与本地报告像素一致。

## 它回答什么问题

挑一个大模型网关/中转 API 时，工程师真正关心的按优先级是：

1. **信任与合规** —— 它信得过吗？渠道来源不靠声明证明，靠**行为指纹组合**黑盒画像：
   模型回显校验（揪偷换）、工具调用是否被剥离、假流式检测（逐 chunk 计时）、
   CJK 输出完整性（量化降智 tell）、上下文截断 needle、usage 重算（揪虚报 token）；
   prompt 留存/训练与主体资质走条款标注 + 证据链接。
2. **价格** —— 它贵不贵？同模型网关价 ÷ 官方价 = 价格指数（官方价取 litellm 价格库）。
3. **稳定性** —— 它最近稳不稳？7/30 天滚动成功率、错误画像（限流/故障/超时分开看）、
   延迟漂移、多地域网络可达（国内直连探针在 roadmap）。
4. *(支撑)* **速度** —— 流式 TTFT p50/p95、吞吐 tok/s。
5. *(支撑)* **模型清单** —— 我要的模型它有没有？协议覆盖如何？

完整指标定义见 [docs/methodology.md](docs/methodology.md)；
为什么做成这个形态、调研了哪些站点与工具，见 [docs/research.md](docs/research.md)。

## 不只是榜单：分析框架

平台不止给数字，还把"怎么判断一个网关靠不靠谱"沉淀成一套分析框架文章
（`web/articles/`，随榜面增长）：从[选型总框架](web/articles/choosing-a-gateway.md)、
[偷换模型与降智检测](web/articles/model-substitution.md)、
[计费陷阱](web/articles/billing-traps.md)、[稳定性与跑路风险](web/articles/stability-and-exit-risk.md)、
到[价格指数方法论](web/articles/price-index.md)与[OpenAI 兼容协议的坑](web/articles/openai-compat-pitfalls.md)。
排行榜每一列都有"读懂这一维 →"深链直达对应文章——数据与框架是一个闭环。

榜面维度：排行榜 · 行为体检（反欺诈指纹一表汇总）· 价格矩阵 · 稳定性时序（含高峰时段画像）·
网关清单 · 分析框架 · 自测指南。

## 模型评测层：选哪个模型最值（[web/evals.html](web/evals.html)）

网关层回答"走哪个网关"；模型层回答"选哪个模型"。数据源 [`data/models.json`](data/models.json)
（官方标价 + 可溯源 benchmark），四块：

- **价格价值实测** —— 交互计算器：选任务（如"写一封 10 万 token 邮件"）或自定义输入/输出 token + 预算/汇率，实时算各模型费用与"同预算谁最值"；
- **权威 benchmark** —— MMLU-Pro / GPQA / SWE-bench / AIME 硬分，**只收有公开出处的，每条挂来源链接 + 采集日期，缺失记「—」不臆造**，并外链 Artificial Analysis / LM Council / OpenCompass 看更全；
- **分场景** —— 把 benchmark 按编码 / 科学 / 数学 / 知识映射，按用途选模型；
- **质量性价比** —— 综合知识分 ÷ 价格 = 每美元买到多少分。

口径定义见 [docs/methodology.md](docs/methodology.md) §模型评测层。

## 形态：无服务器，数据即仓库

```
GitHub Actions（每 6 小时 cron）
  ├─ probe/probe.mjs    拨测 data/gateways.json 里的每个 网关×模型 → data/results/
  ├─ probe/prices.mjs   拉取 litellm 官方价 + 有公开价格接口的网关（synthorai/openrouter）→ data/prices.json
  └─ probe/aggregate.mjs 聚合 results + annotations(人工标注) + prices → web/data.json
       └─ web/index.html 静态读取 data.json 渲染排行榜（GitHub Pages）
```

- **没有服务器、没有数据库**：原始数据逐次 commit，全量可审计、可复现；
- **密钥零入库**：每个网关在 `gateways.json` 里声明 `authEnv`，key 只存在
  GitHub Secrets / 本地环境变量；缺 key 的网关标记为 skipped，不算失败。

## 本地跑一把

```bash
# Node >= 20，零依赖
npm test                                  # 单测（metrics / aggregate / prices）
SYNTHORAI_API_KEY=sk-... node probe/probe.mjs --samples 3 --gateway synthorai --out data/results
npm run prices                            # 刷新价格快照 data/prices.json
npm run aggregate                         # 聚合出 web/data.json
python3 -m http.server -d web 8080        # http://localhost:8080 看排行榜
# （file:// 直接打开会因浏览器限制 fetch 失败，自动回退为演示数据）
```

## 本地 10 分钟高频记录器（macOS）

CI 的美国探针每 6 小时一次；本机探针补上高频 + 本地网络视角（国内直连体感）：

```bash
cp .env.example .env                      # 填入手头有的 API key
./scripts/install-recorder.sh             # 装 launchd 定时器，每 600s 拨测一次
tail -f logs/record.log                   # 看运行日志
```

- 每模型 1 采样控制成本；缺 key 的网关自动跳过，全缺 key 时不写文件；
- 数据持续以 JSON 文档落盘 `data/results/`，git 提交每 ≥6 小时归集一批；
- 卸载：`launchctl unload ~/Library/LaunchAgents/io.llm-gateway-bench.record.plist`。

> **macOS 隐私授权**：仓库在 `~/Documents` 下时，launchd 后台任务首次访问会被 TCC
> 拦截（日志报 `can't open input file`）。首次运行若弹出"zsh 想访问您的'文稿'文件夹"
> 请点允许；没弹的话到 系统设置 → 隐私与安全性 → 文件和文件夹（或完全磁盘访问权限）
> 给 `zsh` 勾上"文稿"，然后 `launchctl kickstart gui/$(id -u)/io.llm-gateway-bench.record`。
> 不想授权也可以在终端前台跑：`npm run record:loop`（终端自带文稿访问权限）。

## 添加一个网关

PR 修改 [`data/gateways.json`](data/gateways.json)：填 `baseUrl`（OpenAI 兼容）、
`authEnv`、`probeModels`（选最便宜的 1-2 个），仓库维护者在 Secrets 里配 key 后自动进入拨测。

贡献网关 / 模型 / benchmark / 标注的完整规则与可信度铁律见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 公正性

- 拨测脚本、探测 prompt、原始数据、聚合逻辑全部公开，任何人可用自己的 key 复现；
- 排行榜不做黑箱加权总分，各维度独立成列；
- 维护者与某网关存在利益关联时在清单条目中披露。

## License

MIT
