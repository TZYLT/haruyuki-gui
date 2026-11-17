import { describe, expect, it } from "vitest";

import {
  CHANNEL_ALLOWLIST,
  BRIDGE_CHANNEL_NAMES,
  BRIDGE_VERSION as SHARED_VERSION,
  DIAGNOSTICS_CHANNELS,
  DROPPED_FILES_CHANNEL,
  validateChannelName,
} from "../../../shared/bridge.js";
import {
  APP_PING,
  BRIDGE_VERSION,
  FRAME_CHANNEL_KEYS,
  FRAME_DELIVER,
  FRAME_SUBMIT,
  LAYOUT_SAVE,
  TERMINAL_ACK,
  TERMINAL_NOTICE,
  channelFor,
  isFrameChannelKey,
} from "../channels.js";

/** Every channel D3 owns or registers; one list so a typo fails once. */
const D3_CHANNELS = [
  FRAME_SUBMIT,
  FRAME_DELIVER.control,
  FRAME_DELIVER.stream,
  FRAME_DELIVER.bulk,
  LAYOUT_SAVE,
  TERMINAL_ACK,
  TERMINAL_NOTICE,
  APP_PING,
] as const;

describe("D3 channel names", () => {
  it("all pass the channel-name grammar", () => {
    for (const name of D3_CHANNELS) {
      expect(validateChannelName(name).ok, name).toBe(true);
    }
  });

  it("are all in the frozen allowlist", () => {
    for (const name of D3_CHANNELS) {
      expect(CHANNEL_ALLOWLIST, name).toContain(name);
    }
  });

  it("keeps the allowlist at exactly D3's eight, D2's one, D4's three and G1's five", () => {
    // The channels in the list this item does not own: D2's dropped-file report, D4's
    // three diagnostics commands and G1's five runtime channels. The comparison stays
    // exact rather than "contains": an unnoticed extra entry is the failure this
    // assertion exists to catch.
    expect([...CHANNEL_ALLOWLIST].sort()).toEqual(
      [
        ...D3_CHANNELS,
        DROPPED_FILES_CHANNEL,
        DIAGNOSTICS_CHANNELS.export,
        DIAGNOSTICS_CHANNELS.relaunch,
        DIAGNOSTICS_CHANNELS.quit,
        "bridge:control.runtime.failed",
        "bridge:control.runtime.log",
        "bridge:control.runtime.pick",
        "bridge:control.runtime.reset",
        "bridge:control.runtime.status",
      ].sort(),
    );
  });

  // This assertion is the ONLY reason the two copies exist; deleting either
  // copy without reading `channels.ts`'s header re-introduces the shared-chunk
  // preload failure.
  it("mirrors the shared names the preload and renderer use", () => {
    expect(BRIDGE_VERSION).toBe(SHARED_VERSION);
    expect(FRAME_SUBMIT).toBe(BRIDGE_CHANNEL_NAMES.frameSubmit);
    expect(FRAME_DELIVER).toEqual(BRIDGE_CHANNEL_NAMES.frameDeliver);
    expect(LAYOUT_SAVE).toBe(BRIDGE_CHANNEL_NAMES.layoutSave);
    expect(TERMINAL_ACK).toBe(BRIDGE_CHANNEL_NAMES.terminalAck);
    expect(TERMINAL_NOTICE).toBe(BRIDGE_CHANNEL_NAMES.terminalNotice);
    expect(APP_PING).toBe(BRIDGE_CHANNEL_NAMES.appPing);
  });

  it("maps each frame channel to one delivery channel", () => {
    expect(FRAME_CHANNEL_KEYS).toEqual(["control", "stream", "bulk"]);
    expect(channelFor("control")).toBe("bridge:control.frame.deliver");
    expect(channelFor("stream")).toBe("bridge:stream.frame.deliver");
    expect(channelFor("bulk")).toBe("bridge:bulk.frame.deliver");
  });
});

describe("frame channel guard", () => {
  it("accepts exactly the three frame channels", () => {
    for (const value of ["control", "stream", "bulk"]) {
      expect(isFrameChannelKey(value)).toBe(true);
    }
  });

  it("refuses prototype keys and non-strings", () => {
    for (const value of ["toString", "__proto__", "Control", "", 1, null, undefined]) {
      expect(isFrameChannelKey(value)).toBe(false);
    }
  });
});
