榜单只测了维护者配了 key 的那些网关。但你真正想知道的，往往是**你自己在用的那一个**靠不靠谱——它可能根本不在榜上。好消息是：这套评测不是一个你只能看的网站，而是一套**你能拿去跑的工具**。拨测脚本、判定逻辑、聚合代码全部开源、零依赖，把任意一个 OpenAI 兼容网关挂上你的 key，三分钟就能出一份和榜单口径完全一致的体检。

## 为什么要自己跑

- **测榜上没有的网关**：你买的小众中转站、公司自建的网关、某个朋友推荐的渠道——加进配置就能测。
- **用你的真实网络视角**：榜单的探针在 GitHub Actions 的美国机房。你在国内/香港跑，拿到的是**你这条链路**的直连延迟与稳定性，而不是别人的。
- **验证而不是轻信**：别人给的结论再漂亮，都不如你用自己的 key、自己的眼睛复现一遍。判定函数是纯函数、带单测，逻辑摊开在那里，没有黑箱。

## 三分钟跑一轮

```
git clone https://github.com/cuihuan/llm-gateway-bench && cd llm-gateway-bench

# 把你的网关加进 data/gateways.json（填 baseUrl / authEnv / probeModels），然后：
YOUR_KEY=sk-... node probe/probe.mjs --samples 3 --gateway <id> --out data/results

npm run aggregate && npm run serve   # → http://localhost:8080
```

需要的只是 Node ≥ 20，没有任何第三方依赖。`--samples 3` 表示每个模型拨测三次取分位数；想测高峰漂移就挂个定时任务（仓库里有 10 分钟一次的本地记录器 `scripts/record.sh` 可直接用）。

## 它会替你测出什么

一轮拨测同时跑完整套行为指纹，对应榜面上你看到的那些列：

- **速度**：流式 TTFT 的 p50/p95、吞吐 tok/s——你这条链路的真实体感。
- **真模型吗**：模型回显校验、工具调用转发、CJK 输出完整性、上下文截断 needle。详见 [偷换模型与降智：黑盒怎么识别](model-substitution)。
- **多收钱吗**：usage 重算指纹（`charsPerToken` / `promptTokens`）、usage 上报率。详见 [计费陷阱：虚报 token、假流式、上下文截断](billing-traps)。
- **稳不稳**：连续跑几天，成功率、错误画像、时段画像就会自己长出来。详见 [稳定性与跑路风险：时间序列才是护城河](stability-and-exit-risk)。

> 单次拨测只能告诉你"这一刻"。偷换模型的概率降级、高峰期的限速、间歇性的故障，都要**连续多次、错峰**才看得见——这正是把它挂成定时任务持续跑的意义。

## 这套工具借鉴了谁

方法论不是凭空来的，对齐了业内成熟实践：流式计时与吞吐测量沿用 llmperf 的惯例（固定小 prompt、多采样取分位数、并发 ≤ 4 避免变成压测）；工具调用保真度的思路来自 [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)；官方价基准取自 litellm 的开放价格库。完整的拨测口径、公平性规则（如探针 key 鉴权失败不计入故障）和可信度设计，见 [我们怎么拨测、为什么可信](methodology-trust)。

## 把你的网关并入公开榜单

如果你愿意让结果进入公开榜单、随时间积累成可信曲线：提一个 PR 修改 `data/gateways.json`，填好 `baseUrl`、`authEnv`、`probeModels`，维护者在 Secrets 配置 key 之后，它就会自动进入每 6 小时一次的拨测。数据逐次 commit、全程可审计——这也是为什么这个榜单**新站抄不走**：壁垒不是代码，是跑了足够久的时间序列。

选网关的完整决策流程，回到 [选大模型网关的完整分析框架](choosing-a-gateway)。
