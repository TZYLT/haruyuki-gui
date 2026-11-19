/**
 * Construction tests for the session protocol types.
 *
 * The package root barrel exports this module's names only after the item that
 * owns it lands, so "the file compiles" is not the same as "a consumer can use
 * it". These tests build real values from every declared shape, which fails to
 * compile at the exact member that drifted and fails at runtime if a code
 * constant is misspelled.
 *
 * They assert shape, not behaviour: there is no implementation here to test.
 */

import { describe, expect, it } from "vitest";

import {
  SESSION_BAD_PARAMS,
  SESSION_CONVERSATION_GONE,
  SESSION_ROW_UNREADABLE,
  SESSION_UNAVAILABLE,
  SESSION_UNKNOWN_SELECTOR,
} from "./types.js";
import type {
  AgentBadge,
  AgentEntity,
  ApprovalEntity,
  BlockEntity,
  ContextView,
  ConversationEntity,
  ConversationRowView,
  DeviceEntity,
  NavRow,
  NavView,
  QueueEntity,
  SessionRowProblemCode,
  SessionSelectCode,
  SessionSnapshot,
  SubagentEntity,
  SubagentNode,
  TurnEntity,
  UsageEntity,
  ViewState,
} from "./types.js";
import type {
  SelectRequest,
  SelectResult,
  SessionResultBody,
  SessionStats,
  SessionStore,
  SessionViewBody,
} from "./select.js";

const agent: AgentEntity = {
  agentId: "agent-1",
  name: null,
  description: null,
  capabilities: {},
  conversations: ["conv-1"],
};

const context: ContextView = {
  tokens: 2000,
  limit: 8000,
  source: "agent-config",
  percentage: 25,
  parts: { system: 100, tools: 50, messages: 1850 },
  estimated: false,
};

const conversation: ConversationEntity = {
  conversationId: "conv-1",
  agentId: "agent-1",
  row: {},
  lastActivityAt: null,
  turns: ["turn-1"],
  context,
  incompleteTurnRefs: ["turn-1"],
};

const turn: TurnEntity = {
  turnRef: "turn-1",
  turnId: null,
  runId: null,
  conversationId: "conv-1",
  stopReason: null,
  open: true,
  blocks: ["block-1"],
  usage: null,
  incomplete: false,
  startedAt: 0,
  finishedAt: null,
};

const block: BlockEntity = {
  blockId: "block-1",
  turnRef: "turn-1",
  messageId: null,
  runId: null,
  block: {},
};

const queue: QueueEntity = { conversationId: "conv-1", items: [], count: 0 };

const subagent: SubagentEntity = {
  subagentId: "sub-1",
  parentAgentId: null,
  conversationId: null,
  status: "pending",
  totalTokens: 0,
  durationMs: 0,
  error: null,
};

const usage: UsageEntity = { conversationId: "conv-1", latest: {}, history: [] };

const approval: ApprovalEntity = {
  requestId: "req-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  toolName: "run",
  input: {},
  state: "pending",
  requestedAt: 0,
};

const device: DeviceEntity = {
  agentId: "agent-1",
  view: {
    isOnline: true,
    isProcessing: false,
    permissionMode: null,
    cwd: null,
    toolsetPreference: null,
    pendingApprovals: 0,
    backgroundProcesses: 0,
    loop: null,
  },
};

const snapshot: SessionSnapshot = {
  revision: 1,
  epoch: 1,
  agents: new Map([[agent.agentId, agent]]),
  conversations: new Map([[conversation.conversationId, conversation]]),
  turns: new Map([[turn.turnRef, turn]]),
  blocks: new Map([[block.blockId, block]]),
  queues: new Map([[queue.conversationId, queue]]),
  subagents: new Map([[conversation.conversationId, [subagent]]]),
  usage: new Map([[usage.conversationId, usage]]),
  approvals: new Map([[agent.agentId, [approval]]]),
  devices: new Map([[device.agentId, device]]),
};

const navRow: NavRow = {
  conversationId: "conv-1",
  title: null,
  badge: 3,
  badgeCapped: false,
  streaming: false,
  incomplete: true,
  pinned: false,
  lastActivityAt: null,
  problem: SESSION_ROW_UNREADABLE,
};

const navView: NavView = { rows: [navRow], hasMore: false };

const conversationRow: ConversationRowView = {
  conversationId: "conv-1",
  title: null,
  state: "ok",
  streaming: false,
  approvals: 0,
};

const subagentNode: SubagentNode = {
  subagentId: "sub-1",
  status: subagent.status,
  children: [],
  totalTokens: 0,
  durationMs: 0,
  error: null,
};

const agentBadge: AgentBadge = {
  agentId: "agent-1",
  unread: 0,
  approvals: 0,
  unreadCapped: false,
};

const viewState: ViewState = { anchor: { id: "block-1", offset: 12 }, collapsed: ["group-1"] };

const request: SelectRequest = {
  instanceId: "tab-1",
  selector: "view.nav",
  params: { agentId: "agent-1", pinned: [], hasMore: false },
  active: true,
};

const result: SelectResult = {
  selector: request.selector,
  params: request.params,
  revision: snapshot.revision,
  epoch: snapshot.epoch,
  value: navView,
};

const viewBody: SessionViewBody = { ...result, instanceId: request.instanceId };

const okResult: SessionResultBody = { ok: true, ...result };
const failedResult: SessionResultBody = {
  ok: false,
  selector: "view.unknown",
  code: SESSION_UNKNOWN_SELECTOR,
};

const stats: SessionStats = {
  revision: 1,
  epoch: 1,
  ingestCount: 0,
  changesApplied: 0,
  changesIgnored: 0,
  pushesSent: 0,
  pushesCoalesced: 0,
  subscriptions: 0,
  dedupeTurns: 0,
  viewStates: 0,
  lastPushAt: null,
};

/**
 * A store-shaped object, not a store: it proves the interface is implementable
 * member by member without dragging in the core package.
 */
const store: SessionStore = {
  getSnapshot: () => snapshot,
  ingest: () => true,
  ingestAgents: () => {},
  ingestConversations: () => {},
  ingestContent: () => {},
  ingestUsage: () => {},
  setContextLimit: () => {},
  subscribe: () => () => {},
  select: () => result,
  viewState: () => viewState,
  setViewState: () => {},
  releaseViewState: () => {},
  rebase: () => {},
  stats: () => stats,
};

describe("session protocol types", () => {
  it("builds a snapshot that keeps every map", () => {
    expect(snapshot.agents.get(agent.agentId)).toBe(agent);
    expect(snapshot.conversations.get(conversation.conversationId)?.context).toBe(context);
    expect(snapshot.turns.get(turn.turnRef)?.open).toBe(true);
    expect(snapshot.turns.get(turn.turnRef)?.turnId).toBeNull();
    expect(snapshot.blocks.get(block.blockId)?.turnRef).toBe(turn.turnRef);
    expect(snapshot.subagents.get(conversation.conversationId)).toEqual([subagent]);
    expect(snapshot.approvals.get(agent.agentId)).toEqual([approval]);
    expect(snapshot.devices.get(device.agentId)?.view.loop).toBeNull();
  });

  it("builds every view type", () => {
    expect(navView.rows).toEqual([navRow]);
    expect(navView.hasMore).toBe(false);
    expect(conversationRow.state).toBe("ok");
    expect(subagentNode.status).toBe("pending");
    expect(agentBadge.unreadCapped).toBe(false);
    expect(viewState.collapsed).toEqual(["group-1"]);
  });

  it("names the failure codes, and only as codes", () => {
    const codes: SessionSelectCode[] = [
      SESSION_UNKNOWN_SELECTOR,
      SESSION_BAD_PARAMS,
      SESSION_UNAVAILABLE,
    ];
    expect(codes).toEqual([
      "SESSION_UNKNOWN_SELECTOR",
      "SESSION_BAD_PARAMS",
      "SESSION_UNAVAILABLE",
    ]);

    const problems: SessionRowProblemCode[] = [SESSION_ROW_UNREADABLE, SESSION_CONVERSATION_GONE];
    expect(problems).toEqual(["row-unreadable", "conversation-gone"]);
  });

  it("carries a request to a result and both reply arms", () => {
    expect(viewBody.instanceId).toBe(request.instanceId);
    expect(viewBody.revision).toBe(snapshot.revision);
    expect(okResult).toMatchObject({ ok: true, selector: request.selector });
    expect(failedResult).toMatchObject({ ok: false, code: "SESSION_UNKNOWN_SELECTOR" });
  });

  it("accepts an object that satisfies the store interface", () => {
    expect(store.getSnapshot().revision).toBe(stats.revision);
    expect(store.subscribe(request, () => {})).toBeTypeOf("function");
  });
});
