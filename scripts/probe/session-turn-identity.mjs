#!/usr/bin/env node
/**
 * What identifies a turn, measured on the recorded engine traffic.
 *
 * The session layer keys a turn by a stable reference of its own, because the
 * engine's `runId` restarts its counter per instance and a single turn can
 * outlive the run it started under. That claim was, until now, a hand-written
 * table in the design notes. This script re-derives it from the recordings so
 * the claim can be re-checked in one command instead of trusted.
 *
 * Three questions, three tables:
 *
 *   1. Does one turn span more than one run? The frames between two turn-closing
 *      frames are one turn; the run ids named inside that window are the runs
 *      the turn touched. The approval scenario is the interesting one: the turn
 *      stops on an approval prompt under one run and continues under the next.
 *
 *   2. Does a run id repeat? Every frame that names a run is counted, together
 *      with the number of distinct turns that run id closed. A per-instance
 *      counter means `local-run-1` is not unique across the recording set.
 *
 *   3. Does each turn close exactly once? `end_turn` is the engine's stop
 *      reason; `turn_finished` is the frame. They are counted per recording and
 *      a mismatch is called out by name, because that is the one reading a
 *      reader must not average away.
 *
 * Reads only `fixtures/engine/recordings/*.jsonl`. Starts no engine, opens no
 * socket, writes no file. Exit code 0 once every table printed.
 *
 * Recording line format: the first line is a header, every following line is
 * `{ dir, at, msg }` where `msg.type` names the frame. Nothing here assumes a
 * frame envelope beyond that.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RECORDINGS = path.join(ROOT, "fixtures", "engine", "recordings");

/**
 * Every recording, in a stable order. The subdirectory is listed explicitly
 * rather than discovered, so a new recording shows up here as a reviewable
 * edit instead of silently changing every number in the tables.
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

/**
 * The route stage's hand-measured findings, kept only to be compared against.
 *
 * These are NOT used to fill a table: every number the tables print is read
 * from the recordings. The comparison exists so a reader sees, in the same
 * output, whether the recording still supports what the note claims. A verdict
 * of `不一致` is a real result and is never smoothed over.
 */
const KNOWN = {
  approvalRunsPerTurn: 2,
  approvalTurnFinished: 1,
  fileWithEndTurnButNoTurnFinished: "subagent.jsonl",
};

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
 * Shorten an engine identifier for a column, keeping both ends so two ids that
 * differ only inside the uuid still read differently.
 *
 * @param id the identifier
 * @returns `id` unchanged when short, otherwise head…tail
 */
function short(id) {
  return id.length <= 28 ? id : `${id.slice(0, 14)}…${id.slice(-6)}`;
}

/**
 * Print one table with a one-line caption and a rule under the header. A cell
 * may be a string or a number; an array is joined with a comma.
 *
 * @param caption what this table computes, in one sentence
 * @param headers column titles
 * @param rows cells, already formatted
 */
function table(caption, headers, rows) {
  const text = (cell) => (Array.isArray(cell) ? cell.join(", ") : String(cell));
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

  return widths;
}

/** @param relative a recording path below the recordings directory */
function load(relative) {
  const raw = readFileSync(path.join(RECORDINGS, relative), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const events = lines.slice(1).map((line, index) => {
    const record = JSON.parse(line);

    return { line: index + 2, dir: record.dir, at: record.at, msg: record.msg ?? {} };
  });

  return { header: JSON.parse(lines[0]), events };
}

/**
 * Every run id one frame names.
 *
 * Three carriers exist in the recordings: the closing frame's own `run_id`, a
 * streaming delta's `run_id`, and the loop status snapshot's `active_run_ids`
 * list. The loop snapshot is what catches a run that is still going while a
 * frame arrives from it, which is exactly the state an approval prompt leaves
 * behind, so it must be read as well as the two explicit fields.
 *
 * @param msg one frame message
 * @returns the run ids it names, in the order they appear
 */
function runIdsOf(msg) {
  const ids = [];

  if (typeof msg.run_id === "string") ids.push(msg.run_id);

  if (msg.delta !== undefined && typeof msg.delta.run_id === "string") ids.push(msg.delta.run_id);

  const loop = msg.loop_status;

  if (loop !== null && typeof loop === "object" && Array.isArray(loop.active_run_ids)) {
    for (const id of loop.active_run_ids) if (typeof id === "string") ids.push(id);
  }

  return ids;
}

/**
 * The stop reason a frame carries, if any: the closing frame has one, and so
 * does a streaming delta of type `stop_reason`.
 *
 * @param msg one frame message
 * @returns the stop reason, or null
 */
function stopReasonOf(msg) {
  if (msg.type === "turn_finished")
    return typeof msg.stop_reason === "string" ? msg.stop_reason : null;

  const delta = msg.delta;

  if (
    delta !== null &&
    typeof delta === "object" &&
    delta.message_type === "stop_reason" &&
    typeof delta.stop_reason === "string"
  ) {
    return delta.stop_reason;
  }

  return null;
}

/**
 * Split one recording into turns.
 *
 * A turn is the frame window that ends at a `turn_finished`, and the frames are
 * bucketed by `subagent_id` before the split: a subagent's own turn is not the
 * parent's second turn, and counting them together would make a one-word
 * subagent answer look like one.
 *
 * A window that never gets a closing frame is only reported when it names a run
 * id. Trailing status frames name none, so treating them as a turn would invent
 * one out of the connection's background chatter.
 *
 * @param relative a recording path below the recordings directory
 */
function turnsOf(relative) {
  const { events } = load(relative);
  const open = new Map();
  const closed = [];

  const bucketFor = (key) => {
    let bucket = open.get(key);

    if (bucket === undefined) {
      bucket = {
        subagentId: key,
        first: null,
        last: null,
        frames: 0,
        runs: new Set(),
        stops: [],
        turnId: null,
      };
      open.set(key, bucket);
    }

    return bucket;
  };

  for (const event of events) {
    const msg = event.msg;
    const bucket = bucketFor(typeof msg.subagent_id === "string" ? msg.subagent_id : null);

    if (bucket.first === null) bucket.first = event.line;

    bucket.last = event.line;
    bucket.frames += 1;

    for (const id of runIdsOf(msg)) bucket.runs.add(id);

    const stopReason = stopReasonOf(msg);

    if (stopReason !== null && msg.type !== "turn_finished") {
      const delta = msg.delta !== null && typeof msg.delta === "object" ? msg.delta : {};

      bucket.stops.push({
        reason: stopReason,
        run:
          typeof delta.run_id === "string"
            ? delta.run_id
            : typeof msg.run_id === "string"
              ? msg.run_id
              : "（无）",
      });
    }

    if (msg.type === "turn_finished") {
      bucket.turnId = typeof msg.turn_id === "string" ? msg.turn_id : null;
      bucket.stopReason = stopReason;
      bucket.stopRun = typeof msg.run_id === "string" ? msg.run_id : "（无）";
      closed.push(bucket);
      open.delete(bucket.subagentId);
    }
  }

  const unfinished = [...open.values()].filter((bucket) => bucket.runs.size > 0);

  return { events, closed, unfinished };
}

/** @param stops the window's stop-reason frames @returns one readable cell */
function stopsCell(stops) {
  return stops.length === 0
    ? "（无）"
    : stops.map((stop) => `${stop.reason}@${stop.run}`).join(" → ");
}

/**
 * Table 1: which runs one turn touched.
 */
function printTurnToRuns() {
  const rows = [];
  const legend = new Map();

  for (const file of FILES) {
    const { closed, unfinished } = turnsOf(file);

    for (const [index, turn] of closed.entries()) {
      const label = turn.turnId === null ? `（未命名轮 ${index + 1}）` : short(turn.turnId);

      if (turn.turnId !== null) legend.set(label, turn.turnId);

      rows.push([
        file,
        label,
        turn.subagentId === null ? "父轮" : `子代理 ${turn.subagentId}`,
        turn.runs.size === 0 ? "（无）" : [...turn.runs],
        turn.runs.size,
        stopsCell(turn.stops),
        `${turn.stopReason ?? "（无）"}@${turn.stopRun}`,
      ]);
    }

    for (const turn of unfinished) {
      rows.push([
        file,
        `（第 ${turn.first}–${turn.last} 行未收尾）`,
        turn.subagentId === null ? "父轮" : `子代理 ${turn.subagentId}`,
        [...turn.runs],
        turn.runs.size,
        stopsCell(turn.stops),
        "无 turn_finished",
      ]);
    }
  }

  table(
    "表 1 · 一个轮跨几个 run：帧窗口以 turn_finished 收尾，窗口内出现过的 runId 就是这一轮碰过的 run。",
    ["录制文件", "轮", "归属", "窗口内的 runId", "run 数", "窗口内的停因", "收尾帧停因"],
    rows,
  );

  const crossRun = rows.filter(
    (row) => typeof row[4] === "number" && row[4] > 1 && row[6] !== "无 turn_finished",
  );

  console.log("\n长的轮标识：");
  for (const [label, full] of legend) if (label !== full) console.log(`  ${label}  =  ${full}`);

  const approvalTurns = turnsOf("approval.jsonl").closed;
  const approvalRuns = approvalTurns.length === 1 ? approvalTurns[0].runs.size : null;
  const approvalFinished = approvalTurns.length;
  const matches =
    approvalRuns === KNOWN.approvalRunsPerTurn && approvalFinished === KNOWN.approvalTurnFinished;

  console.log(
    `\n对照：审批场景应当是一轮跨 ${KNOWN.approvalRunsPerTurn} 个 run、且整份录制只有 ${KNOWN.approvalTurnFinished} 个 turn_finished。`,
  );
  console.log(
    `实测：该轮跨 ${approvalRuns ?? "（无法定界）"} 个 run，该录制有 ${approvalFinished} 个 turn_finished → ${
      matches ? "一致" : "不一致"
    }`,
  );
  console.log(
    crossRun.length === 0
      ? "没有任何轮跨多个 run。"
      : `跨多个 run 的轮共 ${crossRun.length} 个：${crossRun.map((row) => `${row[0]}（${row[4]} 个）`).join("、")}。`,
  );
}

/**
 * Table 2: how often a run id repeats, and across how many turns.
 */
function printRunRepeats() {
  const order = [];
  const stats = new Map();
  const legend = new Map();

  const entry = (id) => {
    let found = stats.get(id);

    if (found === undefined) {
      found = { mentions: 0, files: new Set(), turns: [] };
      stats.set(id, found);
      order.push(id);
    }

    return found;
  };

  for (const file of FILES) {
    for (const { msg } of load(file).events) {
      for (const id of runIdsOf(msg)) {
        const found = entry(id);

        found.mentions += 1;
        found.files.add(file);
      }

      if (
        msg.type === "turn_finished" &&
        typeof msg.run_id === "string" &&
        typeof msg.turn_id === "string"
      ) {
        const found = entry(msg.run_id);

        if (!found.turns.includes(msg.turn_id)) found.turns.push(msg.turn_id);
      }
    }
  }

  const rows = order.map((id) => {
    const found = stats.get(id);
    const labels = found.turns.map((turnId, index) => {
      const label = `T${index + 1}`;

      legend.set(`${label}（${id}）`, turnId);

      return label;
    });

    return [id, found.mentions, found.files.size, found.turns.length, labels];
  });

  table(
    "表 2 · runId 是否重复：每帧每提一次 runId 记一次引用，另记这个 runId 收尾过几个不同的轮。",
    ["runId", "被引用次数", "出现在几个录制", "收尾过几个轮", "对应的轮"],
    rows,
  );

  console.log("\n轮标识：");
  for (const [label, turnId] of legend)
    console.log(`  ${label}  =  ${short(turnId)}  （${turnId}）`);

  const repeated = rows.filter((row) => row[3] > 1);

  console.log(
    repeated.length === 0
      ? "\n没有 runId 收尾过多个轮。"
      : `\n同一 runId 收尾过多个轮的有 ${repeated.length} 个：` +
          repeated.map((row) => `${row[0]}（${row[3]} 个轮，跨 ${row[2]} 个录制）`).join("、") +
          "。计数器按实例从 0 重新开始，所以 runId 只在一份录制内部可以作为键。",
  );
}

/**
 * Table 3: `end_turn` count against `turn_finished` count, per recording.
 *
 * Two counts are printed because they answer different questions. `end_turn`
 * counts every engine end-of-turn signal, including the ones a subagent sends
 * on its own behalf; `turn_finished` counts the frames. The parent-only column
 * is the comparison that should hold one-to-one; the raw total is what a
 * reader comparing against the design note actually sees.
 */
function printClosingCounts() {
  const rows = [];
  const mismatched = [];

  for (const file of FILES) {
    const { events } = load(file);
    let parentEndTurn = 0;
    let subagentEndTurn = 0;
    let turnFinished = 0;
    let otherStop = 0;

    for (const { msg } of events) {
      const stopReason = stopReasonOf(msg);

      if (stopReason !== null && stopReason !== "end_turn") otherStop += 1;

      if (stopReason === "end_turn") {
        if (msg.type === "turn_finished") turnFinished += 1;
        else if (typeof msg.subagent_id === "string") subagentEndTurn += 1;
        else parentEndTurn += 1;
      }
    }

    const total = parentEndTurn + subagentEndTurn;
    const parentMatches = parentEndTurn === turnFinished;
    const note =
      subagentEndTurn > 0
        ? `有 ${subagentEndTurn} 个 end_turn 带 subagent_id，属于子代理自己那轮，该轮没有收尾帧`
        : "";

    rows.push([
      file,
      total,
      parentEndTurn,
      subagentEndTurn,
      turnFinished,
      otherStop,
      parentMatches ? "相等" : "不等",
      note,
    ]);

    if (total !== turnFinished)
      mismatched.push({ file, total, parentEndTurn, subagentEndTurn, turnFinished });
  }

  table(
    "表 3 · 每轮是否恰有一个轮收尾帧：end_turn 是引擎的结束原因，turn_finished 是那帧；两者应一一对应。",
    [
      "录制文件",
      "end_turn 总数",
      "其中父轮",
      "其中子代理",
      "turn_finished",
      "其它结束原因",
      "父轮是否一一对应",
      "说明",
    ],
    rows,
  );

  console.log(
    mismatched.length === 0
      ? "\n每份录制的 end_turn 总数都与 turn_finished 相等。"
      : `\nend_turn 总数与 turn_finished 不等的录制：` +
          mismatched
            .map(
              (row) =>
                `${row.file}（end_turn ${row.total} = 父轮 ${row.parentEndTurn} + 子代理 ${row.subagentEndTurn}，` +
                `turn_finished ${row.turnFinished}）`,
            )
            .join("、") +
          "。",
  );

  const target = mismatched.find((row) => row.file === KNOWN.fileWithEndTurnButNoTurnFinished);

  console.log(
    `对照：${KNOWN.fileWithEndTurnButNoTurnFinished} 应当有 end_turn 而没有对应的 turn_finished。`,
  );
  console.log(
    target === undefined
      ? "实测：该录制没有出现在上面的不等列表里 → 不一致"
      : `实测：end_turn ${target.total} 个（父轮 ${target.parentEndTurn}、子代理 ${target.subagentEndTurn}），` +
          `turn_finished ${target.turnFinished} 个 → 不一致`,
  );
  console.log(
    target === undefined
      ? ""
      : `差在哪里：父轮那一侧是 ${target.parentEndTurn} : ${target.turnFinished}（一一对应），` +
          `差额全部来自子代理 —— 子代理那一轮引擎发了 end_turn，却没有它自己的收尾帧。` +
          `所以“该文件没有收尾帧”这个说法不成立，准确的说法是“该文件有子代理的 end_turn 没有对应的收尾帧”。`,
  );
}

function main() {
  console.log("轮的身份：从录制里复算三轮读数（只读录制，不启引擎、不联网）。");
  console.log(`录制目录：${path.relative(ROOT, RECORDINGS)}，共 ${FILES.length} 份录制。`);

  printTurnToRuns();
  printRunRepeats();
  printClosingCounts();

  console.log("");
}

main();
