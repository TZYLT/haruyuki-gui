# `unknown` 登记表

> 规则：每个 `unknown` 必须登记**原因**与**接管方**。没有登记的 `unknown` 视为缺陷。
>
> 判定顺序：**能引用定义者的类型就引用**（SDK 的 `AgentState`/`Conversation`/`Message`/`*Params`）；**只有引擎内部、且没有可供转写的稳定形状时**才登记为 `unknown`。

| #   | 位置                                                   | 是什么                                                            | 为什么是 `unknown`                                                            | 接管方 / 何时收紧                                      |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| U-1 | `engine-domain.ts` `EphemeralConversationCreateBody`   | 无 agent 的会话创建体（`backend/api/ephemeral-conversations.ts`） | 该形状不在 0.6.0 的协议文档里，只由引擎自己校验；转写会变成一份不可核对的猜测 | 等引擎把它写进协议文档，或该能力真正被用到时按源码收紧 |
| U-2 | `engine-domain.ts` `ConversationProvenance.reflection` | 反思运行记录                                                      | 该字段的载荷由反思功能的实现方定义，本项不拥有这个领域                        | 反思功能落地时由该实现给出形状                         |
| U-3 | `engine-domain.ts` `ConversationProvenance.dream`      | 梦境运行记录                                                      | 同上                                                                          | 梦境功能落地时由该实现给出形状                         |
| U-4 | `file.ts` `LegacyDuplexBody`                           | 双向 legacy 的 `file.ops` 载荷                                    | 它是 CRDT 协议（`cg_entries`/`ops`），没有回帧、不进命令面、不建助手          | 若将来做协同编辑再给出形状                             |

**当前计数：4 条**（1 个类型别名 + 2 个字段 + 1 个 legacy 别名）。
