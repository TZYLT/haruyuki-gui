import { describe, expect, it } from "vitest";

import { CHANNEL_ALLOWLIST, validateChannelName } from "../../../shared/bridge.js";
import {
  APP_PING,
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

  it("keeps the allowlist at exactly the eight channels this item registers", () => {
    expect([...CHANNEL_ALLOWLIST].sort()).toEqual([...D3_CHANNELS].sort());
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
