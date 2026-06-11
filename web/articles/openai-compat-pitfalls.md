"OpenAI 兼容"是中转站的标配卖点——换个 `baseUrl`、复用同一个 SDK，看起来无缝。但**兼容的是接口形状，不是行为**。请求能发出去、能收到一段 JSON，不代表字段语义、流式时序、计费口径和官方一致。很多"玄学 bug"——Agent 工具调用时灵时不灵、usage 对不上账、流式卡顿——根子都在协议层这些不显眼的差异上。

这篇拆几个最常见的协议坑，以及它们怎么对应到平台已经在测的指标。

## 坑一：tool_calls 被剥离或 ID 不合规

OpenAI 的工具调用约定很具体：`finish_reason` 要等于 `tool_calls`，每个调用要有合法的 `function.name` 和能 `JSON.parse` 的 `arguments`，`tool_call_id` 有固定前缀格式。中转/逆向渠道常见两类问题：

- **直接吞掉 tools**：你传了 `tools` 定义，网关转发给上游时丢了，模型当没看见，返回一段普通文本——Agent 链路当场断掉。
- **ID 或 schema 不合规**：返回了 `tool_calls`，但 `arguments` 不是合法 JSON，或 ID 前缀对不上，客户端 SDK 解析报错。

平台的**工具调用转发检查**就是冲这个去的：带一个公开 `tool` 定义发请求，判定模型是否返回该 tool 的合法 JSON 调用（思路源自 [K2 Vendor Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier)）。做 Agent 的人，这一列不过关的网关直接排除。详见 [偷换模型与降智：黑盒怎么识别](model-substitution)。

## 坑二：usage 字段缺失或不可信

OpenAI 流式响应在 `stream_options.include_usage` 下会在末尾给一个带 `usage` 的 chunk。很多中转站**流式不回 usage**——后果是你**无法核对计费**，吞吐 tok/s 也只能拿 chunk 数硬估，不准。

更坏的情况是 usage **回了但不可信**：私调倍率虚报 token，或在你的 prompt 前暗注一段 system prompt 把 `prompt_tokens` 撑大。平台用两个指标盯：**usage 上报率**（流式到底带不带 usage）和 **usage 重算指纹**（`charsPerToken` 异常偏低 = 疑似虚报、`promptTokens` 远超基线 = 疑似暗注）。详见 [计费陷阱：虚报 token、假流式、上下文截断](billing-traps)。

## 坑三：流式不合规——假流式与 chunk 时序

SSE 流式的本意是边生成边吐字。不合规的实现里最典型的是**假流式**：网关后台憋完整段回复，再切成 chunk 一次性 dump，伪装成流。表现是首字延迟（TTFT）几乎等于总延迟，所有内容挤在一瞬间到达。

这不只是体验问题——它把"上游慢/排队"的真相藏了起来，让你以为很快。平台逐 chunk 打时间戳，用首字延迟与首末 chunk 时间窗的关系判定假流式（`isBurstStream`），快但真流式和慢但真流式都不会误伤。原理详见 [计费陷阱：虚报 token、假流式、上下文截断](billing-traps)。

## 坑四：model 字段回显与上下文窗口

两个安静的坑：

- **`model` 回显对不上**：响应 JSON 里的 `model` 字段，理应回显你请求的模型。对不上（请求 A 回显 B）是偷换的直接硬证据——平台的**模型回显校验**零成本搭车流式就能抓。
- **上下文窗口名不副实**：声称 128K，实际为省上游成本悄悄截断。平台用 needle 检测（长文里埋唯一标记要求原样回读）来验，尾部截断会让标记确定性丢失。

## 怎么用这篇

下次接入一个新网关，别只验"能不能跑通"，按协议层逐项过：

1. **工具调用**：带 `tools` 发一发，看 `finish_reason` 和 `arguments` 合不合规；
2. **usage**：开 `include_usage`，确认流式末尾真有 usage，并和本地 token 估算对一对；
3. **流式时序**：逐 chunk 打时间戳，看 TTFT 是不是约等于总延迟（假流式信号）；
4. **model 回显**：核对响应里的 `model` 字段；
5. **上下文**：长文前部埋个随机串让它回读。

这五项平台都在自动测，对应**行为体检**面板的各列——但你完全可以用自己的 key 复现，see [开源工具与自建拨测：把这套搬到你自己的环境](self-host-probing)。回到选型全景：[选大模型网关的完整分析框架](choosing-a-gateway)。
