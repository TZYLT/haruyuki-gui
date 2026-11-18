/**
 * The device projection: eight fields out of a thirteen-kilobyte settings dump.
 *
 * The failure this suite exists to catch is a projection that keeps "a bit more,
 * it cannot hurt" - the payload is 11306 bytes at the median and the channel
 * frame is 16 KB, so a projection that forwards the payload whole is not slower,
 * it is undeliverable. The first assertion below is therefore a byte ceiling on
 * a recording, and it goes red the moment someone returns the payload untouched.
 *
 * The rest pins the two semantics that make the row trustworthy:
 *
 * - **an unreported field is not a zero** (a count of `0` background processes
 *   and "the engine did not say" draw differently), so an absent field stays
 *   `null` and a missing required field refuses the row instead of guessing;
 * - **a bad payload is a row, not an exception**, so the three shapes of
 *   malformed input each come back as a code.
 *
 * The last full-frame / last-frame-only case is the "any state to any state"
 * requirement stated for a snapshot: the payload is a full snapshot, so a
 * consumer that joins late must land on the same row.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { DEVICE_VIEW_BYTES, createDeviceProjector, projectDevice, readLoop } from "./device.js";

/** One recorded s2c line. */
type Recorded = { readonly dir?: string; readonly msg?: Record<string, unknown> };

const RECORDINGS = new URL("../../../../fixtures/engine/recordings/", import.meta.url);

/** Every device frame in one recording, in file order. */
function deviceFrames(file: string): Recorded[] {
  const text = readFileSync(new URL(file, RECORDINGS), "utf8");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Recorded)
    .filter((frame) => frame.dir === "s2c" && frame.msg?.["type"] === "update_device_status");
}

/** The engine's state out of one recorded frame. */
function stateOf(frame: Recorded): Record<string, unknown> {
  return frame.msg?.["device_status"] as Record<string, unknown>;
}

/** A change the merger would have produced for one recorded frame. */
function deviceChange(value: unknown, agentId = "agent-local-1"): MergerChange {
  return {
    kind: "state.device",
    authorAgentId: agentId,
    runtimeAgentId: agentId,
    subagentId: null,
    conversationId: "default",
    at: 1,
    value,
  };
}

/** The change for one recorded frame. */
function changeOf(frame: Recorded): MergerChange {
  return deviceChange(frame.msg);
}

/** The largest recorded device frame, and the smallest, for the volume check. */
const frames = deviceFrames("approval.jsonl");
const largest = frames.reduce((best, frame) =>
  JSON.stringify(stateOf(frame)).length > JSON.stringify(stateOf(best)).length ? frame : best,
);
const smallest = frames.reduce((best, frame) =>
  JSON.stringify(stateOf(frame)).length < JSON.stringify(stateOf(best)).length ? frame : best,
);

describe("a real device frame fits one frame of the channel", () => {
  it.each([
    ["largest", () => largest],
    ["smallest", () => smallest],
  ])("projects the %s recorded payload under the byte ceiling", (_label, pick) => {
    const frame = pick();
    const payload = stateOf(frame);
    const reading = projectDevice(changeOf(frame));

    expect(reading.entity).not.toBeNull();

    const raw = JSON.stringify(payload).length;
    const projected = JSON.stringify(reading.entity).length;

    // Printed rather than asserted on: the numbers are the evidence, and a
    // hard-coded expectation would fail on a fixture refresh for no reason.
    console.log(`device payload ${_label}: raw ${raw} B -> projected ${projected} B`);

    expect(projected).toBeLessThanOrEqual(DEVICE_VIEW_BYTES);
    // The whole point of the projection: the raw payload does not fit.
    expect(raw).toBeGreaterThan(DEVICE_VIEW_BYTES);
  });

  it("keeps the eight contract fields and nothing else", () => {
    const view = projectDevice(changeOf(largest)).entity?.view;

    expect(view).toBeDefined();
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "backgroundProcesses",
      "cwd",
      "isOnline",
      "isProcessing",
      "loop",
      "pendingApprovals",
      "permissionMode",
      "toolsetPreference",
    ]);
    expect(typeof view?.isOnline).toBe("boolean");
    expect(typeof view?.isProcessing).toBe("boolean");
    expect(typeof view?.pendingApprovals).toBe("number");
    expect(typeof view?.backgroundProcesses).toBe("number");
    // This frame carries no loop state; the slot is fed by the assembly layer
    // through `setLoop`, and until then it holds "not reported".
    expect(view?.loop).toBeNull();
  });

  it("reads the permission mode and working directory the page needs", () => {
    const state = stateOf(smallest);

    expect(projectDevice(changeOf(smallest)).entity?.view).toMatchObject({
      permissionMode: state["current_permission_mode"],
      cwd: state["current_working_directory"],
      toolsetPreference: state["current_toolset_preference"],
    });
  });
});

describe("the last frame alone is enough", () => {
  it("lands on the same row whether it folds every frame or only the last one", () => {
    const all = createDeviceProjector();
    const lastOnly = createDeviceProjector();

    for (const frame of frames) {
      all.apply(changeOf(frame));
    }

    const final = frames[frames.length - 1];
    expect(final).toBeDefined();
    lastOnly.apply(changeOf(final as Recorded));

    expect(all.latest).toEqual(lastOnly.latest);
    expect(all.stats.readable).toBe(frames.length);
    expect(lastOnly.stats.readable).toBe(1);
  });

  it("never clears the last good row because a later one is bad", () => {
    const projector = createDeviceProjector();

    projector.apply(changeOf(largest));
    const good = projector.latest;

    projector.apply(deviceChange({ device_status: {} }));
    projector.apply(deviceChange("not an object"));

    expect(projector.latest).toEqual(good);
    expect(projector.stats.missingFields).toBe(1);
    expect(projector.stats.unreadable).toBe(1);
    expect(projector.stats.readable).toBe(1);
  });
});

describe("an unreported field is not a zero", () => {
  it("reports null rather than a made-up value for a field the engine omitted", () => {
    const payload = stateOf(smallest);
    const reading = projectDevice(
      deviceChange({ device_status: { ...payload, current_toolset_preference: undefined } }),
    );

    expect(reading.entity?.view.toolsetPreference).toBeNull();
    expect(reading.entity?.view.cwd).toBe(payload["current_working_directory"]);
  });

  it("refuses the row rather than defaulting a count the contract cannot express as null", () => {
    const payload = stateOf(smallest);
    const reading = projectDevice(
      deviceChange({ device_status: { ...payload, background_processes: undefined } }),
    );

    expect(reading.entity).toBeNull();
    expect(reading.problem).toBe("missing-fields");
  });
});

describe("a row that cannot be read is a code, not a throw", () => {
  const payload = stateOf(smallest);

  it("refuses a payload with a missing required field", () => {
    const reading = projectDevice(
      deviceChange({ device_status: { ...payload, is_online: undefined } }),
    );

    expect(reading).toEqual({ entity: null, problem: "missing-fields" });
  });

  it("refuses a payload whose field has the wrong type", () => {
    const reading = projectDevice(
      deviceChange({ device_status: { ...payload, background_processes: "three" } }),
    );

    expect(reading).toEqual({ entity: null, problem: "wrong-type" });
  });

  it("refuses an oversized payload instead of emitting a row the frame would cut", () => {
    const reading = projectDevice(
      deviceChange({
        device_status: { ...payload, current_working_directory: "x".repeat(4096) },
      }),
    );

    // The over-long string is dropped, not truncated, so the row still fits.
    expect(reading.entity?.view.cwd).toBeNull();
    expect(JSON.stringify(reading.entity).length).toBeLessThanOrEqual(DEVICE_VIEW_BYTES);

    // An identity the envelope lets through, but the frame cannot: refused,
    // because there is nothing to drop without inventing a different agent.
    const swamped = projectDevice(deviceChange(stateOf(smallest), "a".repeat(4096)));

    expect(swamped).toEqual({ entity: null, problem: "oversized" });
  });

  it("refuses a hostile payload without throwing", () => {
    const hostile = {
      get device_status(): unknown {
        throw new Error("a getter is not data");
      },
    };

    expect(() => projectDevice(deviceChange(hostile))).not.toThrow();
    expect(projectDevice(deviceChange(hostile)).problem).toBe("unreadable");
  });

  it("refuses a change of another kind by code", () => {
    const reading = projectDevice({
      kind: "state.loop",
      authorAgentId: "agent-local-1",
      runtimeAgentId: "agent-local-1",
      subagentId: null,
      conversationId: "default",
      at: 1,
      value: {},
    });

    expect(reading).toEqual({ entity: null, problem: "not-a-device-change" });
  });
});

describe("the payload carries nothing to remove", () => {
  it("has no removal list, so every row is a whole snapshot", () => {
    // The queue frame carries a `removed` delta; the device frame does not, and
    // the contract's row has no slot for one. Stated as an assertion so that a
    // future removal delta shows up here first, before it silently strands a
    // row that the projection never re-reads.
    for (const frame of frames) {
      expect(stateOf(frame)).not.toHaveProperty("removed");
    }

    expect(Object.keys(projectDevice(changeOf(smallest)).entity ?? {})).toEqual([
      "agentId",
      "view",
    ]);
  });
});

describe("the loop state is fed in, not taken from another change", () => {
  it("puts the recorded loop state on the next row", () => {
    const projector = createDeviceProjector();

    projector.setLoop("EXECUTING_CLIENT_SIDE_TOOL");
    const reading = projector.apply(changeOf(smallest));

    expect(reading.entity?.view.loop).toBe("EXECUTING_CLIENT_SIDE_TOOL");
    expect(projector.latest?.view.loop).toBe("EXECUTING_CLIENT_SIDE_TOOL");
  });

  it("returns the slot to null when the caller has no loop state", () => {
    const projector = createDeviceProjector();

    projector.setLoop("WAITING_ON_APPROVAL");
    projector.apply(changeOf(smallest));
    expect(projector.latest?.view.loop).toBe("WAITING_ON_APPROVAL");

    projector.setLoop(null);
    projector.apply(changeOf(smallest));

    expect(projector.latest?.view.loop).toBeNull();
  });

  it("keeps the loop state across a device frame that does not mention it", () => {
    const projector = createDeviceProjector();

    projector.setLoop("SENDING_API_REQUEST");

    // Two device frames, neither of which names a loop state: the projection
    // must not drop it between frames.
    projector.apply(changeOf(smallest));
    projector.apply(changeOf(largest));

    expect(projector.latest?.view.loop).toBe("SENDING_API_REQUEST");
  });

  it("treats an empty or non-string loop state as absent", () => {
    expect(readLoop("")).toBeNull();
    expect(readLoop(undefined)).toBeNull();
    expect(readLoop(7)).toBeNull();
    expect(readLoop("WAITING_ON_INPUT")).toBe("WAITING_ON_INPUT");

    const projector = createDeviceProjector();
    projector.setLoop("WAITING_ON_INPUT");
    projector.setLoop("");
    projector.apply(changeOf(smallest));

    expect(projector.latest?.view.loop).toBeNull();
  });
});

describe("the byte ceiling holds for multi-byte text too", () => {
  it("stays under 512 both as characters and as UTF-8 bytes", () => {
    const payload = stateOf(smallest);
    const cwd = "J:/项目/会话/一组很长的目录名";

    const reading = projectDevice(
      deviceChange({ device_status: { ...payload, current_working_directory: cwd } }),
    );
    const serialized = JSON.stringify(reading.entity);

    // The primary ruler is character count, matching the probe that measures
    // frame sizes; byte length is the extra check, because a multi-byte path
    // makes the two disagree in the unsafe direction.
    console.log(
      `device cwd projection: chars ${serialized.length} B, utf8 ${Buffer.byteLength(serialized)} B`,
    );

    expect(reading.entity?.view.cwd).toBe(cwd);
    expect(serialized.length).toBeLessThanOrEqual(DEVICE_VIEW_BYTES);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(DEVICE_VIEW_BYTES);
  });
});

describe("the diagnostic counts say why a row was refused", () => {
  it("counts a missing field and a mistyped field apart", () => {
    const projector = createDeviceProjector();
    const payload = stateOf(smallest);

    projector.apply(deviceChange({ device_status: { ...payload, is_online: undefined } }));
    projector.apply(deviceChange({ device_status: { ...payload, is_processing: "yes" } }));
    projector.apply(deviceChange({ device_status: { ...payload, background_processes: 3 } }));
    projector.apply(deviceChange(stateOf(smallest), "a".repeat(4096)));
    projector.apply(deviceChange({ device_status: {} }));

    expect(projector.stats).toEqual({
      readable: 0,
      missingFields: 2,
      wrongType: 2,
      oversized: 1,
      unreadable: 0,
    });
  });
});
