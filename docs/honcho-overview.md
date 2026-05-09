# Honcho 项目深度解析

> 一份关于 Honcho（AI Agent 记忆与社会认知基础设施）核心机制的整理，围绕实际使用中可能产生的疑问展开。

## 一、Honcho 是什么？

**Honcho** 是为 AI Agent 提供**长期记忆**和**社会认知**能力的基础设施层。它解决的核心问题是：让 LLM 应用能够长期记住用户、理解用户心理、并据此提供个性化响应。

主要用途：
- 给 AI Agent 赋予"身份感"
- 通过理解用户心理来个性化体验
- 通过 **Dialectic API** 在需要时实时注入用户上下文
- 支持多方会话（人类与 AI Agent 混合参与）

### 核心概念：Peer 范式

Honcho 采用统一的 **Peer 范式**——无论是用户还是 AI，都被抽象为"peer"（参与者）。

| 原语 | 作用 |
|---|---|
| **Workspace** | 根组织单元（旧称 App） |
| **Peer** | 任何参与者，人或 AI（旧称 User） |
| **Session** | 一次会话上下文，可包含多个 peer |
| **Message** | 通信数据，或被某 peer 摄取的任意数据 |
| **Collections / Documents** | 内部向量存储（不对外暴露） |

### 三大 Agent 协作机制

| Agent | 角色 | 触发方式 | 入口 |
|---|---|---|---|
| **Deriver** | 记忆形成者：从消息中提取观察 | 消息入队后台处理 | `src/deriver/agent/worker.py` |
| **Dialectic** | 分析回忆者：策略性收集上下文回答查询 | `/peers/{peer_id}/chat` | `src/dialectic/chat.py` |
| **Dreamer** | 巩固者：随机游走探索观察、合并冗余 | 定时或显式 dream 任务 | `src/dreamer/agent.py` |

---

## 二、Q1：用户与 Agent 对话时，是被识别为两个 Peer 吗？Honcho 怎么识别 peer？需要显式传 peer_id 吗？数据协议是怎样的？

**是的，用户和 Agent 会被识别为两个独立的 Peer。**

Honcho 的识别机制非常直接：**peer 的"身份"就是一个 `name` 字符串，由调用方显式指定**。Honcho 不做"这是谁"的识别——依赖你的业务系统给定名字。

- **写入消息时必须显式传 `peer_id`**
- 同名 peer 在同一 workspace 下视为同一 peer（不存在则自动创建）
- 不同 peer 之间通过 `observer / observed` 关系建立"A 眼中的 B"的表征

### 写入数据协议

API：`POST /v1/workspaces/{workspace_id}/sessions/{session_id}/messages`（批量最多 100 条）

```json
{
  "messages": [
    {
      "peer_id": "user_42",
      "content": "我最近在学日语",
      "metadata": { "source": "web" },
      "configuration": { },
      "created_at": "2026-04-30T..."
    },
    {
      "peer_id": "assistant_bot",
      "content": "哦，是想去日本旅游吗？"
    }
  ]
}
```

注意：`MessageCreate.peer_name = Field(alias="peer_id")` —— 对外字段是 `peer_id`，内部存储是 `peer_name`。一个 session 可有任意多个 peer 交替发言。

---

## 三、Q2：记忆如何被读取与使用？Dialectic 底层机制是怎样的？请用一段交互推演。即时上下文注入会破坏 Provider 缓存吗？

### Dialectic 接口

API：`POST /v1/workspaces/{ws}/peers/{peer_id}/chat`

```json
{
  "query": "这个用户最近在学什么？喜欢哪种学习方式？",
  "session_id": "session_xyz",
  "target": "user_42",
  "stream": true,
  "reasoning_level": "low"
}
```

关键参数：
- **observer**：路径里的 `peer_id`，提问者
- **observed**：`target`，被问的人；缺省则等于 observer（上帝视角）

### 底层机制：带工具调用循环的 Agent

```
DialecticAgent.answer(query)
   ↓ 组装系统提示（含 observer/observed 的 peer card 摘要）
   ↓ 进入 honcho_llm_call 循环：
       LLM 决定调用哪些工具 →
           search_memory（向量检索观察）
           get_recent_history（最近消息）
           get_observation_context（某条观察的上下文）
           search_messages / grep_messages
           get_recent_observations / get_most_derived_observations
           get_session_summary
           get_peer_card
           create_observations（推理出新观察并写回）
       （多轮 tool call 直到模型不再调用工具）
   ↓ 返回自然语言答案
```

LLM **自主决定**要查什么、查多少——这是与传统 RAG 的关键差异。

### 推演一段交互

**1）用户与 Agent 实时聊天：**
- 用户：「我打算下个月去京都，但我对人多的地方有点焦虑」
- Agent：「考虑过岚山的早晨吗？」

**2）应用把消息异步丢给 Honcho：**
```
POST /sessions/trip_chat/messages
[
  { peer_id: "user_42", content: "我打算下个月去京都..." },
  { peer_id: "agent",   content: "考虑过岚山的早晨..." }
]
```

**3）Deriver 后台处理**（消息入 Redis 队列）

LLM 读消息 → 调用 `create_observations` 写入：
- 显式：「user_42 计划下个月去京都」
- 演绎：「user_42 在拥挤环境中感到焦虑」「user_42 有规划倾向」

→ 嵌入向量存入 `documents` 表（HNSW 索引）

**4）下一轮，Agent 在回答前先咨询 Honcho：**
```
POST /peers/agent/chat
{
  "query": "我该怎么帮 user_42 规划京都行程？需要注意什么？",
  "target": "user_42",
  "session_id": "trip_chat"
}
```

**5）DialecticAgent 内部工具循环：**
```
LLM tool_call → search_memory("京都 旅行 偏好")
  ← [观察1: 计划去京都, 观察2: 对人多焦虑]
LLM tool_call → search_memory("社交焦虑 拥挤")
  ← [观察3: 偏好清晨/小众路线]
LLM tool_call → get_peer_card(user_42)
  ← ["规划型旅行者", "对人多敏感", ...]
LLM 不再调用工具 → 输出综合建议
```

**6）你的 Agent 把这段答复作为临时 context 拼到自己的下一次 LLM 调用中，回复用户。**

### 关于 Provider 端 Prompt Caching

**"即时注入"含义：** 你不需要把全部用户历史塞进 Agent 的 system prompt。每次需要个性化时调一次 `/chat`，Honcho 返回**当下查询最相关的浓缩答案**（一段自然语言）。

**会不会破坏取决于你怎么拼。** 以 Anthropic prompt caching 为例：

```
[ 静态 system prompt + 工具定义 ]   ← cache_control: ephemeral，命中
[ 历史消息 ]                         ← 增量增长，部分命中
[ 新一轮：Honcho 注入的上下文 + 用户新消息 ]  ← 不缓存
```

要点：
1. **把 Honcho 返回的内容放在"缓存断点之后"**（如最后一条 user message 里），而不是塞进固定 system prompt 头部——否则每次内容不同会让前缀失配，缓存全部失效。
2. Honcho 返回是一次性的查询响应，每轮可能不同，天然不应进入缓存前缀区。
3. 如果坚持要把 Honcho 上下文放进 system，可在它前面再放 `cache_control` 断点。

简而言之：**Honcho 不会自动破坏缓存——它是外部 HTTP 调用，与主对话 LLM 完全解耦**；只要把它的输出放在"易变区段"，主 LLM 的 prompt cache 仍然有效。

---

## 四、Q3：记忆一定是通过 Observation 形式记录吗？没有 observer/observed 关系的内容会被记住吗？

**几乎是的，但要分层看。** Honcho 内部存了三类东西：

| 存储 | 作用 | 是否带 observer/observed |
|---|---|---|
| **Message**（原始消息） | 你 POST 进来的原文 | 只标 `peer_id`，无 observer/observed |
| **Observation**（观察） | Deriver 提炼的事实/推断，存入向量库 | **是**，挂在 `(observer, observed)` 关系下 |
| **Peer Card** | 关于被观察者的简短画像 | **是**，挂在 observer 的 `internal_metadata` |

所以 POST 的所有消息**都被原样保留**（可 `search_messages`/`grep_messages` 搜回），但真正可被 `search_memory` 检索的语义化"记忆片段"全部是 observation 形式。

### Observation 的 4 种 level

- **explicit**：直接事实（"用户说他在京都"）
- **deductive**：逻辑必然推论（要求 `source_ids` 指向前提）
- **inductive**：模式归纳（preference / behavior / personality / tendency / correlation）
- **contradiction**：与既有信息冲突的陈述

### 无关系内容会丢吗？

如果消息无法被解读为"关于某个 peer 的事实"，Deriver 不会创建 observation，但**消息本身仍在数据库**（可被 grep / 关键词检索）。

- 记忆的"长期表征层"只接受关系化（observer→observed）信息
- 消息层是无关系的兜底原始档案

ingest 一段非对话资料（如文档、笔记）时，通常做法是把它作为某个 peer 的 message 推入。

---

## 五、Q4：什么是 Peer Card？

**Peer Card 是"observer 眼中 observed 的一段简短人物画像"**，本质是一个字符串列表（bullet 形式的传记条目）。

存储位置（`src/crud/peer_card.py:103`）：

```python
# 挂在 observer peer 的 internal_metadata JSONB 里
# key 格式：
#   observer == observed → "peer_card"
#   observer != observed → f"{observed}_peer_card"
```

举例：
```json
{
  "user_42_peer_card": [
    "30 岁，软件工程师",
    "对人多场景敏感",
    "偏好早晨出行、规划型旅行者",
    "正在自学日语"
  ]
}
```

### 用途

1. **Dialectic Agent 启动时立即注入 system prompt**——给 Agent 一个"快速人物速写"
2. **由 Deriver / Dreamer 用 `update_peer_card` 持续维护**——它是从 observation 浓缩出的便利摘要，不是独立真相来源
3. **稳定、慢变**：相比海量 observation，peer card 数量小、更新慢，适合直接注入对话上下文

可以把它理解为：observation 是"原子事实库"，peer card 是"人物名片"。

---

## 六、Q5：Agent 怎么知道要去查记忆？是 system prompt 注入 + LLM 自主推理吗？

**两层机制叠加：**

### 第一层：Honcho 内部的 DialecticAgent —— 是的

启动后，Honcho 的 DialecticAgent 的 system prompt 非常详细地教 LLM：
- "你是 context synthesis agent，要从 memory system 收集信息回答问题"
- 列出所有可用工具：`search_memory`、`get_reasoning_chain`、`search_messages`、`grep_messages`、`get_observation_context` 等
- 给出 8 步 WORKFLOW（分析查询 → 先查偏好 → 战略性检索 → 枚举类问题用 grep + 多次语义搜索 + 去重 → 用 reasoning chain 验证 → 处理矛盾/更新信息 → 综合回答 → 可选保存新推断）

通过 `honcho_llm_call` 进入工具循环，**LLM 自主决定**调哪些工具、何时停下。

### 第二层：你的应用侧 Agent —— 由你决定

业务 Agent 不会自己知道要查 Honcho，有两种集成方式：

**A. 显式调用（最常见）**
```python
context = honcho.peers["assistant"].chat(
    query="user_42 的相关偏好与状态？",
    target="user_42"
)
```

**B. 把 Honcho 暴露成工具给你的 Agent**

注册 `dialectic_query(query, target)` 为工具，让你的 LLM 自主决定调不调。

### 总结对比

| 层级 | 谁触发 | 怎么知道 |
|---|---|---|
| Honcho 内部 DialecticAgent 工具调用 | LLM 自主 | system prompt 列工具 + 工作流 |
| 业务 Agent 何时调 `/chat` | 你的代码 | 你写死，或注册成工具自决 |
| Deriver 何时形成记忆 | 系统自动 | POST messages 即触发后台队列 |

---

## 七、Q6：Peer Card 详细机制（数量、长度、注入策略）

### 多对多关系下的 Peer Card 数量

**peer card 数量 = (observer × observed) 中实际有过观察关系的组合数**

```
observer 的 internal_metadata = {
  "peer_card":           [...],   # 看自己
  "user_42_peer_card":   [...],   # 看 user_42
  "user_99_peer_card":   [...],   # 看 user_99
}
```

### 同一被观察者下，observer 是否会有多张 card？

**不会**。`(observer, observed)` 关系下只有一张，整体覆盖式写入。但同一个 observed 会被多个 observer 各自维护一张 card——体现"主观视角"。

### 长度限制

- **条目数硬上限：40 条**（`MAX_PEER_CARD_FACTS`）。超过自动截断。
- **单条文本长度**：无显式上限，受 token 预算约束，实践上一句话级别。
- 整张大小：40 × 一句话 ≈ 几百到一两千 tokens。

### Dialectic 启动时注入了哪些 Peer Card？

**只注入两张**：
1. `observer_peer_card`：observer 看自己
2. `observed_peer_card`：observer 看 observed

如果 `observer == observed`，只注入一张。**绝不会一次性注入该 observer 的全部 N 张 card**——这是有意为之，避免堆历史。需要别的 peer 信息时，Agent 在循环里主动调 `get_peer_card`。

全局开关：`PEER_CARD_ENABLED`。

---

## 八、Q7：记忆检索是 LLM 调用循环，会不会很慢？性能与效果如何保证？

是的，工具调用循环天然慢——一次 `/chat` 可能多次 LLM + 多次向量检索 + 多次 DB。Honcho 的应对措施：

### 1. 五档 reasoning level

| Level | MAX_TOOL_ITERATIONS | 工具集 | 预取 | 用途 |
|---|---|---|---|---|
| minimal | 1 | MINIMAL（精简） | 10 条/类 | 低延迟 |
| low | 5 | 完整 | 25 条/类 | 默认 |
| medium | 2 | 完整 | 25 条/类 | — |
| high | 4 | 完整 | 25 条/类 | — |
| max | 10 | 完整 | 25 条/类 | 复杂枚举/总结 |

`minimal` 还设 `TOOL_CHOICE="any"` + `MAX_OUTPUT_TOKENS=250`，是真正快档。

### 2. 启动时 Prefetch

DialecticAgent 在第一次 LLM 调用前用查询 embedding 先跑两次向量检索（explicit + derived 各一次），结果作为初始 user 消息塞进去。简单问题首轮即可答出，无需任何 tool call。

### 3. 流式响应（SSE）

`/chat` 支持 `stream: true`，按 chunk 推回。首 token 时间远小于总耗时。

### 4. DB 连接严格不跨外部调用

`tracked_db("dialectic.preflight")` 短作用域只做校验和拿 peer card 后立即关闭，LLM 工具循环期间不占连接，避免连接池被慢 LLM 拖垮。

### 5. 工具内部并行 + 数据库索引

- 同轮多 tool call 并行执行
- `search_memory` 用预计算 embedding + pgvector HNSW 索引
- `search_messages` / `grep_messages` 走 SQL 索引
- 工具输出限长：`MAX_TOOL_OUTPUT_CHARS=10000`

### 6. 多缓存层

- Peer 对象 read-through cache
- Workspace / configuration 缓存
- Embedding 客户端复用

### 7. 硬性 ceiling

`MAX_TOOL_ITERATIONS` 全局上限 50，代码层 100，永不无限循环。

### 部署建议

- **每轮调用** → `minimal` / `low`，依靠 prefetch，1–2 秒
- **关键决策点** → `high` / `max`，5–15 秒换准确性
- **离线分析/Dreamer** → 不进用户路径，可放宽

---

## 九、Q8：群聊场景下，能否一次性检索多个目标的记忆？

**不能，当前架构只支持单目标，需多次调用。**

### 限制位置

1. **API 层**：`DialecticOptions.target: str | None`，只接受单个 peer name
2. **Agent 初始化**：`self.observed: str` 单值，prefetch 只对该 observed 跑 search_memory
3. **工具层**：`search_memory(observer, observed, ...)`、`get_peer_card`、`get_recent_observations` 全部锁定单 observed

底层原因：observation 在数据库里按 `(observer, observed)` 关系分区存储（每对关系对应独立 collection），单次向量检索无法跨 collection。

### 现状下的应对：并行多次调用

```python
ctxs = await asyncio.gather(
    honcho.peers["agent"].chat(query=q, target="user_A"),
    honcho.peers["agent"].chat(query=q, target="user_B"),
    honcho.peers["agent"].chat(query=q, target="user_C"),
)
prompt = f"""
关于 user_A: {ctxs[0]}
关于 user_B: {ctxs[1]}
关于 user_C: {ctxs[2]}
请综合回答：{q}
"""
```

延迟 ≈ 单次（并行），成本 = N 倍 token。配合 `reasoning_level="minimal"` 每次 1–2 秒。

### 这是设计取舍

1. **observation 主观性**：跨 observed 混合检索会污染语义
2. **Peer Card 是双方画像**：注入"observer 看 observed"才有意义
3. **Reasoning chain 归属**：deductive 的 source_ids 只在同一关系里有效

### 演进方向（如需原生支持）

- `DialecticOptions.target: str | list[str]`
- DialecticAgent 接受 observed 列表，prefetch N 次并行后合并
- 工具层加 `search_memory_multi(observed: list[str], ...)`
- system prompt 改写为"群体画像"叙事 + 多 peer card 截断

但短期更务实仍是**并行多次单目标 + 应用层拼接**——与 Honcho "每个 peer 是独立认知主体"的范式更一致。

---

## 总结

Honcho 的设计哲学可以概括为三点：
1. **统一 Peer 范式** + **关系化观察**：所有"记忆"都是某 observer 眼中某 observed 的事实/推断
2. **三 Agent 协作**：Deriver 写、Dialectic 读、Dreamer 巩固
3. **即时上下文注入**：通过 `/chat` API 把浓缩答案送给业务 Agent，不污染 Provider 端缓存

性能上通过分档 reasoning + prefetch + 流式 + 严格的 DB 连接规范来平衡延迟与效果；多目标场景由调用方在应用层并行拼接。
