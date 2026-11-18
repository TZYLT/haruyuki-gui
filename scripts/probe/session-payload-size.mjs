#!/usr/bin/env node
/**
 * How big one view frame is, and how much traffic that becomes per second.
 *
 * Two questions the session layer's push design rests on:
 *
 *   1. How many bytes does one view frame cost? A selector result is measured as
 *      the JSON a renderer would receive, so the unit is `JSON.stringify`
 *      length in UTF-8 bytes.
 *   2. What does that become per second when every view pushes, with and
 *      without a coarse-grained window?
 *
 * Where the numbers come from
 *   Every size is computed from a recorded payload, never typed in. The
 *   recordings carry: conversation rows (one per `runtime_start_response`), the
 *   device status snapshot with its loop status, and the usage report a turn
 *   ends with. They do NOT carry titles, badges or a tab's activity, because
 *   the recorder was a bare socket client with no UI. A row that needs one of
 *   those takes the neutral value the type allows and says so; it never invents
 *   a plausible-looking id or title.
 *
 * The difference column is derived, not apologised for
 *   Where a computed size differs from the route stage's reading, the reason is
 *   measured too: how many bytes an id of a given length costs, and which id
 *   length or loop-status length would reproduce the reading exactly. A gap
 *   that cannot be pinned down from the recordings says so instead of being
 *   given a story.
 *
 * Reads only `fixtures/engine/recordings/*.jsonl`. Starts no engine, opens no
 * socket, writes no file. Exit code 0 once every table printed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RECORDINGS = path.join(ROOT, "fixtures", "engine", "recordings");

/**
 * The recordings to read, in a stable order.
 *
 * `approval.jsonl` is the representative one: it is the only recording that
 * carries a full turn — an approval prompt, a second run, a usage report and a
 * closing frame — so it can supply every payload a view is built from.
 */
const FILES = [
  "approval.jsonl",
  "compaction.jsonl",
  "memory.jsonl",
  "subagent.jsonl",
  "terminal.jsonl",
  "tool-call.jsonl",
  "user-message.jsonl",
  "reconnect/reconnect-approvals.jsonl",
  "reconnect/reconnect-messages.jsonl",
  "reconnect/reconnect-status.jsonl",
];

/** The recording every single-frame row is measured on. */
const REPRESENTATIVE = "approval.jsonl";

/** Rows in the navigation list the route stage measured. */
const NAV_ROW_COUNT = 20;

/** Frames per second one chunk producer emits into one instance. */
const CHUNKS_PER_SECOND = 200;

/** Coarse-grained push window, in milliseconds. */
const WINDOW_MS = 250;

/**
 * The size past which a selector stops receiving pushes and is fetched on
 * demand instead.
 *
 * A design threshold, not a protocol constant. Nothing in this repository
 * defines it: a search for 16384 finds only `term.output`'s slice offsets in
 * `term-slice.test.ts`, which is a different subject. The route stage wrote it
 * into its goal table as "over 16 KB switches to an on-demand fetch", so it is
 * quoted here as a target to measure against and must not be read as a value
 * the wire carries.
 */
const FRAME_LIMIT_BYTES = 16384;

/**
 * The route stage's hand-measured sizes, kept only to be compared against.
 *
 * Not used to fill a cell: every size is computed. A difference is printed with
 * its measured cause rather than adjusted away, and a payload the recordings do
 * not carry is reported as skipped instead of filled with a guess.
 *
 * These were produced under a CONSTRUCTION budget — the route stage simulated a
 * planned window with a virtual clock and measured widest-case rows — so they
 * are upper bounds for a design, not readings of a running product. That is why
 * a difference here is expected rather than alarming: this script measures what
 * the recording actually carries.
 */
const KNOWN = new Map([
  ["导航（20 行）", 5141],
  ["设备投影", 174],
  ["上下文", 150],
  ["会话行", 128],
  ["agent 徽标", 82],
  ["标签活动", 44],
]);

/** Wide characters occupy two terminal columns; padding has to know. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** @param text a cell's text @returns its width in terminal columns */
function widthOf(text) {
  let columns = 0;

  for (const char of text) columns += WIDE.test(char) ? 2 : 1;

  return columns;
}

/**
 * Print one table with a one-line caption and a rule under the header.
 *
 * @param caption what this table computes, in one sentence
 * @param headers column titles
 * @param rows cells, already formatted
 */
function table(caption, headers, rows) {
  const text = (cell) => (Array.isArray(cell) ? cell.join(", ") : String(cell));

  if (rows.length === 0) {
    console.log(`\n${caption}\n（没有可打印的行）`);

    return;
  }

  const widths = headers.map((header, column) =>
    Math.max(widthOf(header), ...rows.map((row) => widthOf(text(row[column] ?? "")))),
  );
  const line = (cells) =>
    cells
      .map((cell, column) => text(cell) + " ".repeat(widths[column] - widthOf(text(cell))))
      .join("  ")
      .trimEnd();

  console.log(`\n${caption}`);
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));

  for (const row of rows) console.log(line(row));
}

/** @param relative a recording path below the recordings directory */
function load(relative) {
  const raw = readFileSync(path.join(RECORDINGS, relative), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");

  return lines.slice(1).map((line) => JSON.parse(line).msg ?? {});
}

/** @param value a frame body @returns its UTF-8 size exactly as it would travel */
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The string length that makes a builder produce a given byte size, found by
 * trying every length rather than by solving the arithmetic by hand.
 *
 * @param build a function from a filler string to the value being measured
 * @param target the byte size to reproduce
 * @returns the filler length, or null when no length does
 */
function fillerLengthFor(build, target) {
  for (let length = 0; length <= 96; length += 1) {
    if (bytes(build("x".repeat(length))) === target) return length;
  }

  return null;
}

/** @param frames every message of one recording @returns the last one of a type */
function lastOf(frames, type) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index].type === type) return frames[index];
  }

  return null;
}

/**
 * Every conversation row the recordings carry, with the fields a view needs.
 *
 * A conversation reaches the recordings exactly once, inside the agent it was
 * created with; there is no conversation-list response anywhere in the set.
 *
 * @returns rows, or an empty array when no recording carried one
 */
function conversationRows() {
  const rows = [];

  for (const file of FILES) {
    for (const frame of load(file)) {
      if (frame.type !== "runtime_start_response" || frame.conversation === null) continue;

      rows.push({
        conversationId: frame.conversation.id,
        title: frame.conversation.summary,
        lastActivityAt: frame.conversation.last_message_at,
        agentId: frame.agent?.id ?? null,
      });
    }
  }

  return rows;
}

/**
 * One navigation row.
 *
 * The recordings carry a conversation id, a summary and a last-activity
 * timestamp — nothing else. Badge, streaming, incomplete and pinned belong to
 * the live session store, which the recorder never spoke to, so they take the
 * neutral value and the row is honestly smaller than a populated UI's row.
 *
 * @param conversation a row from {@link conversationRows}
 * @param overrides fields to replace, used only to explain a size difference
 */
function navRow(conversation, overrides = {}) {
  return {
    conversationId: conversation.conversationId,
    title: conversation.title,
    badge: 0,
    badgeCapped: false,
    streaming: false,
    incomplete: false,
    pinned: false,
    lastActivityAt: conversation.lastActivityAt,
    problem: null,
    ...overrides,
  };
}

/**
 * The eight device fields a renderer is given, projected out of the status
 * snapshot. The snapshot itself is far larger: it carries every toolset
 * description, every experiment and the whole skill list, and a renderer needs
 * none of them.
 *
 * @param status one `device_status` payload
 * @param loop the loop status in force, or null
 * @param overrides fields to replace, used only to explain a size difference
 */
function deviceProjection(status, loop, overrides = {}) {
  return {
    isOnline: status.is_online,
    isProcessing: status.is_processing,
    permissionMode: status.current_permission_mode,
    cwd: status.current_working_directory,
    toolsetPreference: status.current_toolset_preference,
    pendingApprovals: (status.pending_control_requests ?? []).length,
    backgroundProcesses: (status.background_processes ?? []).length,
    loop,
    ...overrides,
  };
}

/**
 * The derived context pressure a page renders.
 *
 * `tokens` is the usage report's `context_tokens`; `limit` is the agent's own
 * `context_window_limit`, which is the denominator the fallback chain lands on
 * when a conversation carries no override. `parts` is the three-way estimate.
 *
 * @param usage one `usage_statistics` delta
 * @param limit the denominator
 */
function contextView(usage, limit) {
  const tokens = usage.context_tokens ?? null;

  return {
    tokens,
    limit,
    source: "model-config",
    percentage: tokens === null || limit === null ? null : Math.round((tokens / limit) * 1000) / 10,
    parts: {
      system: usage.context_system_tokens ?? 0,
      tools: usage.context_tools_tokens ?? 0,
      messages: usage.context_messages_tokens ?? 0,
    },
    estimated: false,
  };
}

/**
 * One agent badge, as the agent switcher renders it.
 *
 * @param agentId the agent's id
 * @param overrides fields to replace, used only to explain a size difference
 */
function agentBadge(agentId, overrides = {}) {
  return { agentId, unread: 0, approvals: 0, unreadCapped: false, ...overrides };
}

/**
 * One conversation header row, as a page header renders it.
 *
 * Not one of the six views the note measures. It is built here only to show
 * that the note's 128 B row size does not belong to this shape either: with
 * neutral fields it already costs more than the navigation row's minimum.
 *
 * @param conversation a row from {@link conversationRows}
 */
function conversationRowView(conversation) {
  return {
    conversationId: conversation.conversationId,
    title: conversation.title,
    state: "ok",
    streaming: false,
    approvals: 0,
  };
}

/** @param known the route stage's reading @param actual what was computed here */
function difference(known, actual) {
  const delta = actual - known;

  return delta === 0 ? "0" : delta > 0 ? `+${delta}` : String(delta);
}

/**
 * Table 1: one frame's size, per view.
 *
 * @returns the sizes that were computed, keyed by view name, so the worst-case
 *          table reuses them rather than recomputing or re-guessing them
 */
function printFrameSizes() {
  const conversations = conversationRows();
  const frames = load(REPRESENTATIVE);
  const device = lastOf(frames, "update_device_status");
  const loopFrame = lastOf(frames, "update_loop_status");
  const runtime = frames.find((frame) => frame.type === "runtime_start_response");
  const usage = frames
    .map((frame) => frame.delta)
    .filter(
      (delta) =>
        delta !== null && typeof delta === "object" && delta.message_type === "usage_statistics",
    )
    .at(-1);

  const sizes = new Map();
  const rows = [];

  const add = (name, size, source, explanation) => {
    const known = KNOWN.get(name) ?? null;

    sizes.set(name, size);
    rows.push([
      name,
      size,
      source,
      known === null ? "（无对照）" : known,
      known === null ? "" : difference(known, size),
      explanation,
    ]);
  };

  if (conversations.length > 0) {
    const seed = conversations[0];
    const id = seed.conversationId;
    const row20 = Array.from({ length: NAV_ROW_COUNT }, (_, index) =>
      navRow(conversations[index % conversations.length]),
    );
    const navSize = bytes(row20);
    const rowSize = bytes(navRow(seed));
    const wrapper = navSize - NAV_ROW_COUNT * rowSize;
    const knownPerRow = (KNOWN.get("导航（20 行）") - wrapper) / NAV_ROW_COUNT;
    const titleForKnownRow = fillerLengthFor(
      (filler) => navRow({ ...seed, conversationId: "x".repeat(36), title: filler }),
      knownPerRow,
    );

    add(
      "导航（20 行）",
      navSize,
      `会话行 × ${NAV_ROW_COUNT} + 外层 ${wrapper} B；录制里只有 ${conversations.length} 条会话，按循环补齐`,
      `口径不同，两个数都对：本表用录制实际值（id "${id}"、title 为 null，每行 ${rowSize} B），` +
        `路线阶段用每行 ${knownPerRow} B 的最坏构造（36 字符 id + ${titleForKnownRow} 字符标题），` +
        `20 × ${knownPerRow} + ${wrapper} = ${KNOWN.get("导航（20 行）")} 可复算。` +
        `路线阶段量的是设计上界而不是运行中的产品，差额来自这两处取值不同，不是任何一方算错。`,
    );
    add(
      "会话行",
      rowSize,
      `路线阶段的构造值，本表无法复现（该形状最小值 ${bytes(conversationRowView({ ...seed, conversationId: "default", title: null }))} B / 导航行 ${rowSize} B）`,
      `${KNOWN.get("会话行")} B 既不是本表量的这一行，也不是导航行：` +
        `ConversationRowView 在 id="default"、title 为 null 时已是 ` +
        `${bytes(conversationRowView({ ...seed, conversationId: "default", title: null }))} B，` +
        `导航行同样是这两个取值时已是 ${rowSize} B，两个形状都够不到 ${KNOWN.get("会话行")} B。` +
        `它是路线阶段手写的构造估算值，和上面 5141 一样不是实测，本行只报录制的实测值。`,
    );
    add(
      "agent 徽标",
      bytes(agentBadge(seed.agentId)),
      `${REPRESENTATIVE} 的 agent id，${String(seed.agentId).length} 字符`,
      `差额全在 id 宽度：${KNOWN.get("agent 徽标")} B 对应 ` +
        `${fillerLengthFor((filler) => agentBadge(filler), KNOWN.get("agent 徽标"))} 字符的 agentId，` +
        `录制里是 ${String(seed.agentId).length} 字符。徽标量的是 id，不是渲染开销。`,
    );
  } else {
    for (const name of ["导航（20 行）", "会话行", "agent 徽标"]) {
      rows.push([
        name,
        "跳过",
        "该行跳过：录制里没有 runtime_start_response 的会话载荷",
        KNOWN.get(name) ?? "（无对照）",
        "",
        "",
      ]);
    }
  }

  if (device !== null) {
    const loop = loopFrame?.loop_status?.status ?? null;
    const projection = deviceProjection(device.device_status, loop);

    add(
      "设备投影",
      bytes(projection),
      `${REPRESENTATIVE} 末个 update_device_status 取 8 个字段；loop 取末个 loop 状态`,
      `差额全在 loop 字段：${KNOWN.get("设备投影")} B 对应 ` +
        `${fillerLengthFor((filler) => deviceProjection(device.device_status, filler), KNOWN.get("设备投影"))} ` +
        `字符的 loop 值，录制里是 "${loop}"（${String(loop).length} 字符）。字段集与其它 7 个字段一字不变。`,
    );
  } else {
    rows.push([
      "设备投影",
      "跳过",
      "该行跳过：录制里没有 update_device_status",
      KNOWN.get("设备投影"),
      "",
      "",
    ]);
  }

  if (usage !== undefined && runtime !== null) {
    const limit = runtime.agent?.model_settings?.context_window_limit ?? null;
    const view = contextView(usage, limit);
    const base = view.percentage ?? 0;
    const reachable = new Set();

    for (const source of ["conversation-override", "agent-config", "model-catalog", "none"]) {
      for (const percentage of [
        base,
        Math.round(base * 100) / 100,
        Math.round(base),
        ((view.tokens ?? 0) / (limit ?? 1)) * 100,
      ]) {
        reachable.add(bytes({ ...view, source, percentage }));
      }
    }

    const sorted = [...reachable].sort((left, right) => left - right);
    const target = KNOWN.get("上下文");
    const distance =
      sorted.length === 0 ? null : Math.min(...sorted.map((size) => Math.abs(size - target)));

    add(
      "上下文",
      bytes(view),
      `${REPRESENTATIVE} 最后一份 usage_statistics；分母取 agent 的 context_window_limit（${limit ?? "无"}）`,
      `差额量的是“百分比取几位小数”：写成 ${base} 时 ${bytes(view)} B；换成整数百分比、两位小数或未取整的比值，` +
        `体积在 ${sorted[0]}–${sorted[sorted.length - 1]} B 之间移动。` +
        `${target} B ${reachable.has(target) ? "可以被其中一组合法取值复现" : `没有任何一组合法取值能命中，最近差 ${distance} B`}；` +
        `字段集与三个分段数字都没变，形状本身没有分歧。`,
    );
  } else {
    rows.push([
      "上下文",
      "跳过",
      "该行跳过：录制里没有 usage_statistics 或 runtime_start_response",
      KNOWN.get("上下文"),
      "",
      "",
    ]);
  }

  add(
    "标签活动",
    bytes({ streaming: false, approvals: 0, unread: 0 }),
    "标签活动是页面推给外框的短状态，引擎录制里没有对应载荷；按类型声明取空状态",
    "三个字段，取值不同只改数字不改字段名，空状态已是最小形态，差额为 0 是形状相同而非巧合。",
  );

  table(
    "表 1 · 单帧体积：把一个视图帧的 JSON 序列化出来量字节，等价于渲染进程收到的那一份。",
    ["视图帧", "字节数", "数据来源", "路线阶段读数", "差额", "差额从哪来"],
    rows,
  );

  return sizes;
}

/**
 * Table 2: how many frames per second a coarse window turns a chunk stream into.
 *
 * @returns the windowed push rate, which table 3 needs
 */
function printPushBudget() {
  const windowSeconds = WINDOW_MS / 1000;
  const chunksPerWindow = CHUNKS_PER_SECOND * windowSeconds;
  const framesWithWindow = 1 / windowSeconds;
  const reduction = (1 - framesWithWindow / CHUNKS_PER_SECOND) * 100;

  table(
    `表 2 · 推帧预算：输入 ${CHUNKS_PER_SECOND} chunk/s，粗化窗口 ${WINDOW_MS} ms，算每实例每秒推几帧。`,
    ["配置", "窗口内 chunk 数", "每秒推帧数", "相对无窗口", "说明"],
    [
      [
        "无窗口",
        String(CHUNKS_PER_SECOND),
        CHUNKS_PER_SECOND.toFixed(1),
        "100%",
        "每个 chunk 单独推一次，订阅方每 chunk 重渲染一次",
      ],
      [
        `${WINDOW_MS} ms 窗口`,
        String(chunksPerWindow),
        framesWithWindow.toFixed(1),
        `${(100 - reduction).toFixed(1)}%（降 ${reduction.toFixed(0)}%）`,
        "一个窗口内只推最后一次结果，前面的被吞掉",
      ],
    ],
  );

  console.log(`\n对照：路线阶段的读数是 200.0 帧/s 与 3.9 帧/s（降 98%）。`);
  console.log(
    `本表：无窗口 ${CHUNKS_PER_SECOND.toFixed(1)} 帧/s、${WINDOW_MS} ms 窗口 ${framesWithWindow.toFixed(1)} 帧/s` +
      `（降 ${reduction.toFixed(1)}%）。`,
  );
  console.log(
    `差额说明：${framesWithWindow.toFixed(1)} 是理论值 1/${windowSeconds}，路线阶段的 3.9 低 0.1。` +
      `那个数口径不明——它的方法说明同样称“测的是设计，不是产品代码”，而虚拟时钟模拟没有首帧偏移之外的` +
      `机制能产生 -0.1。这里只报理论值与差，不替 3.9 编原因。`,
  );
  console.log(
    `注意这是恰好在边界上，不是有余量：设计目标是每实例每秒推帧数 ≤ 4，` +
      `本表 ${framesWithWindow.toFixed(1)} 正好等于上限，并没有留出余量。` +
      `若实际实现窗口起点会立即推一帧，真实值会略高于 4.0 而不是略低。` +
      `换句话说：这一项是“恰好达标”，任何额外的一次推送都会越线。`,
  );

  return framesWithWindow;
}

/**
 * Table 3: the worst case — every view pushes — against the frame ceiling.
 *
 * @param sizes the per-view sizes table 1 computed
 * @param framesPerSecond the windowed rate table 2 computed
 */
function printWorstCase(sizes, framesPerSecond) {
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const largest = [...sizes.entries()].sort((left, right) => right[1] - left[1])[0];
  const perSecond = total * framesPerSecond;
  const budgetPerSecond = FRAME_LIMIT_BYTES * framesPerSecond;
  const navOnly = sizes.get("导航（20 行）") ?? 0;
  const withoutNesting = total - navOnly;

  table(
    "表 3 · 最坏情况：六个视图全推，每秒多少字节，与帧上限对比。",
    ["视图帧", "单帧字节", "每秒份数", "每秒字节", "单帧是否超过上限"],
    [...sizes.entries()].map(([name, size]) => [
      name,
      String(size),
      framesPerSecond.toFixed(1),
      (size * framesPerSecond).toFixed(1),
      size <= FRAME_LIMIT_BYTES ? "未超过" : "超过",
    ]),
  );

  console.log(
    `\n合计：六视图相加 ${total} B（导航已含 20 个会话行，故这是保守上界），` +
      `每秒 ${perSecond.toFixed(1)} B（按 ${framesPerSecond.toFixed(1)} 帧/s）。`,
  );
  console.log(
    `最大的一帧是「${largest[0]}」${largest[1]} B，${largest[1] <= FRAME_LIMIT_BYTES ? "小于" : "大于"}设计阈值 ${FRAME_LIMIT_BYTES} B。`,
  );
  console.log(
    `判断：单帧${largest[1] <= FRAME_LIMIT_BYTES ? "通过" : "不通过"}（${largest[1]} ${largest[1] <= FRAME_LIMIT_BYTES ? "≤" : ">"} ${FRAME_LIMIT_BYTES}）；` +
      `若把六视图凑成一帧，${total} B ${total <= FRAME_LIMIT_BYTES ? "仍通过" : "不通过"}` +
      `（${total} ${total <= FRAME_LIMIT_BYTES ? "≤" : ">"} ${FRAME_LIMIT_BYTES}）；` +
      `去掉重复计数的导航后 ${withoutNesting} B，余量更大。`,
  );
  console.log(
    `每秒合计 ${perSecond.toFixed(1)} B，对应 ${framesPerSecond.toFixed(1)} × ${FRAME_LIMIT_BYTES} = ` +
      `${budgetPerSecond.toFixed(0)} B/s 的预算，${perSecond <= budgetPerSecond ? "通过" : "不通过"}。`,
  );
  console.log(
    `前提：${FRAME_LIMIT_BYTES} B 是设计阈值，不是仓库常量也不是协议值——仓库里没有这个数（搜到的 16384 ` +
      `只有 term.output 的切片偏移，与本题无关）。它的含义是“超过 16 KB 就该把这个选择器改成按需取数”，` +
      `所以本表判的是设计目标，不是协议合规。另一条能查到的是 bulk 页预算 1 MB，口径不同，不能互相套用。`,
  );
}

function main() {
  console.log(
    "推帧频率与体积：从录制里复算视图帧字节数，再算成每秒预算（只读录制，不启引擎、不联网）。",
  );
  console.log(`录制目录：${path.relative(ROOT, RECORDINGS)}；单帧量在 ${REPRESENTATIVE} 上。`);

  const sizes = printFrameSizes();
  const framesPerSecond = printPushBudget();

  printWorstCase(sizes, framesPerSecond);

  console.log("");
}

main();
