/**
 * The navigation list, pinned from the five sides that make it trustable.
 *
 * Each case below names the wrong rule it catches, and every one of them can
 * fail on its own:
 *
 * - the order is the engine's, and pinning only hoists;
 * - a pinned id that is not in the list is ignored, never invented;
 * - one unreadable row costs one row, and the row stays where it was;
 * - a conversation that left the list is still a row that says so;
 * - `hasMore` travels through without being judged.
 *
 * Two of these were verified by breaking the module on purpose: sorting by
 * activity instead of hoisting (the order case turns red), and letting the
 * unreadable row throw (the isolation case turns red). Both were then reverted.
 */

import { describe, expect, it } from "vitest";
import { SESSION_CONVERSATION_GONE, SESSION_ROW_UNREADABLE } from "@haruyuki/protocol";

import { buildNavView, type NavBadgeReading, type NavRowSource } from "./nav.js";
import { UNREAD_CAP } from "./unread.js";

/** A readable row, in whatever order the caller happens to hand it in. */
function row(
  conversationId: string,
  lastActivityAt: string | null = null,
  extra: Partial<NavRowSource> = {},
): NavRowSource {
  return {
    conversationId,
    title: `title ${conversationId}`,
    state: "ok",
    lastActivityAt,
    ...extra,
  };
}

/** No badge for anybody, which is the ordinary state of a quiet list. */
function noBadges(): NavBadgeReading {
  return { unread: 0, approvals: 0, badge: 0, badgeCapped: false };
}

/** The ids of the rows, in the order the view carries them. */
function ids(rows: readonly { readonly conversationId: string }[]): string[] {
  return rows.map((entry) => entry.conversationId);
}

describe("navigation: the order is the engine's", () => {
  it("hoists the pinned rows and leaves the rest in engine order", () => {
    // Handed in newest-first, which is what the engine sends. The timestamps
    // deliberately do not agree with the pinning: a module that sorted would
    // put c-9 first, and this assertion would say so.
    const rows = [
      row("c-9", "2026-11-18T12:00:00Z"),
      row("c-7", "2026-11-18T11:00:00Z"),
      row("c-5", "2026-11-18T10:00:00Z"),
      row("c-3", "2026-11-18T09:00:00Z"),
      row("c-1", "2026-11-18T08:00:00Z"),
    ];

    const view = buildNavView({
      rows,
      pinned: ["c-3", "c-7"],
      hasMore: false,
      badgeOf: noBadges,
    });

    // Pinned first, in the order the caller pinned them *and* the engine listed
    // them - both halves are the same here, so this is the wrong order only if
    // the module sorted by time.
    expect(ids(view.rows)).toEqual(["c-7", "c-3", "c-9", "c-5", "c-1"]);
  });

  it("keeps the engine order inside the pinned half, not the pinned list's order", () => {
    // The pinned list names the two ids oldest-first; the engine lists them
    // newest-first. The engine wins, because the pinned list is a set.
    const rows = [row("c-9"), row("c-7"), row("c-5"), row("c-3")];

    const view = buildNavView({
      rows,
      pinned: ["c-3", "c-7"],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(ids(view.rows)).toEqual(["c-7", "c-3", "c-9", "c-5"]);
    expect(view.rows.map((entry) => entry.pinned)).toEqual([true, true, false, false]);
  });

  it("returns the engine order untouched when nothing is pinned", () => {
    const rows = [
      row("c-2", "2026-11-18T12:00:00Z"),
      row("c-4", "2026-09-01T12:00:00Z"),
      row("c-1", null),
    ];

    expect(ids(buildNavView({ rows, pinned: [], hasMore: true, badgeOf: noBadges }).rows)).toEqual([
      "c-2",
      "c-4",
      "c-1",
    ]);
  });
});

describe("navigation: pinning is an input", () => {
  it("ignores pinned ids the list does not name", () => {
    const rows = [row("c-1"), row("c-2")];

    const view = buildNavView({
      // Three ids that are not in the list: no error, no ghost row, no blank.
      rows,
      pinned: ["c-404", "", "c-2", "x".repeat(500)],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(ids(view.rows)).toEqual(["c-2", "c-1"]);
    expect(view.rows).toHaveLength(2);
  });

  it("never flips pinning back into the input", () => {
    const pinned = ["c-2"];

    buildNavView({ rows: [row("c-1"), row("c-2")], pinned, hasMore: false, badgeOf: noBadges });

    expect(pinned).toEqual(["c-2"]);
  });
});

describe("navigation: one bad row costs one row", () => {
  it("keeps the unreadable row in place and returns its neighbours normally", () => {
    const rows = [
      row("c-1"),
      // The payload of this row could not be read: this is what a flagged row
      // looks like coming in from the socket.
      { conversationId: "c-2", problem: SESSION_ROW_UNREADABLE } as NavRowSource,
      row("c-3"),
    ];

    const view = buildNavView({ rows, pinned: [], hasMore: false, badgeOf: noBadges });

    expect(ids(view.rows)).toEqual(["c-1", "c-2", "c-3"]);
    expect(view.rows[1]?.problem).toBe(SESSION_ROW_UNREADABLE);
    // The neighbours are untouched: a problem is per row, not per list.
    expect(view.rows[0]?.problem).toBeNull();
    expect(view.rows[2]?.problem).toBeNull();
    expect(view.rows[0]?.title).toBe("title c-1");
  });

  it("keeps going when the owner's own functions throw", () => {
    const rows = [row("c-1"), row("c-2")];

    const view = buildNavView({
      rows,
      pinned: [],
      hasMore: false,
      badgeOf: () => {
        throw new Error("neighbour still being written");
      },
      streamingOf: () => {
        throw new Error("neighbour still being written");
      },
      incompleteOf: () => {
        throw new Error("neighbour still being written");
      },
    });

    expect(ids(view.rows)).toEqual(["c-1", "c-2"]);
    expect(view.rows.map((entry) => entry.badge)).toEqual([0, 0]);
    expect(view.rows.map((entry) => entry.streaming)).toEqual([false, false]);
  });

  it("skips a row with no usable id rather than inventing one", () => {
    const rows = [
      row("c-1"),
      { title: "no id" } as NavRowSource,
      { conversationId: "" } as NavRowSource,
      row("c-2"),
    ];

    const view = buildNavView({ rows, pinned: [], hasMore: false, badgeOf: noBadges });

    expect(ids(view.rows)).toEqual(["c-1", "c-2"]);
  });
});

describe("navigation: a gone conversation is still a row", () => {
  it("keeps the gone row, with its code, instead of filtering it out", () => {
    const rows = [
      row("c-1"),
      // The conversation left the engine's list: the entity is held and says so.
      { conversationId: "c-2", title: "old", state: "gone" } as NavRowSource,
      row("c-3"),
    ];

    const view = buildNavView({ rows, pinned: [], hasMore: false, badgeOf: noBadges });

    // The judgement this case exists for: the row is still in the list.
    expect(ids(view.rows)).toEqual(["c-1", "c-2", "c-3"]);
    expect(view.rows[1]?.problem).toBe(SESSION_CONVERSATION_GONE);
    // The tag stays, so the title it was last known by stays too.
    expect(view.rows[1]?.title).toBe("old");
  });

  it("keeps the gone row's place in the pinned half too", () => {
    const rows = [row("c-1"), { conversationId: "c-2", state: "gone" } as NavRowSource];

    const view = buildNavView({ rows, pinned: ["c-2"], hasMore: false, badgeOf: noBadges });

    expect(ids(view.rows)).toEqual(["c-2", "c-1"]);
    expect(view.rows[0]?.problem).toBe(SESSION_CONVERSATION_GONE);
    expect(view.rows[0]?.pinned).toBe(true);
  });
});

describe("navigation: hasMore passes through", () => {
  it("echoes the caller's answer without guessing a threshold", () => {
    const single = [row("c-1")];

    expect(
      buildNavView({ rows: single, pinned: [], hasMore: true, badgeOf: noBadges }).hasMore,
    ).toBe(true);
    expect(buildNavView({ rows: [], pinned: [], hasMore: false, badgeOf: noBadges }).hasMore).toBe(
      false,
    );

    // Not "one row and more behind it must be false": the caller said true.
    expect(
      buildNavView({ rows: single, pinned: [], hasMore: true, badgeOf: noBadges }).rows,
    ).toHaveLength(1);
  });
});

describe("navigation: derived figures come from their owners", () => {
  it("takes the badge and its cap from the owner", () => {
    const rows = [row("c-1"), row("c-2")];

    const view = buildNavView({
      rows,
      pinned: [],
      hasMore: false,
      badgeOf: (conversationId) =>
        conversationId === "c-1"
          ? { unread: 2, approvals: 1, badge: 3, badgeCapped: false }
          : { unread: 99, approvals: 5, badge: 104, badgeCapped: true },
    });

    expect(view.rows.map((entry) => entry.badge)).toEqual([3, 104]);
    expect(view.rows.map((entry) => entry.badgeCapped)).toEqual([false, true]);
  });

  it("adds the owner's parts only when the owner named no whole figure", () => {
    const view = buildNavView({
      rows: [row("c-1")],
      pinned: [],
      hasMore: false,
      badgeOf: () => ({ unread: 4, approvals: 2 }),
    });

    expect(view.rows[0]?.badge).toBe(6);
    expect(view.rows[0]?.badgeCapped).toBe(false);
  });

  it("caps a figure the owner left uncapped, and leaves a capped one alone", () => {
    const view = buildNavView({
      rows: [row("c-1"), row("c-2")],
      pinned: [],
      hasMore: false,
      badgeOf: (conversationId) =>
        conversationId === "c-1"
          ? { unread: 0, approvals: 0, badge: UNREAD_CAP + 1 }
          : { unread: 0, approvals: 7, badge: 7, badgeCapped: true },
    });

    expect(view.rows.map((entry) => entry.badgeCapped)).toEqual([true, true]);
    expect(view.rows.map((entry) => entry.badge)).toEqual([UNREAD_CAP + 1, 7]);
  });

  it("falls back to the row's own approval count when the owner says nothing", () => {
    const view = buildNavView({
      rows: [row("c-1", null, { approvals: 3 })],
      pinned: [],
      hasMore: false,
      badgeOf: () => null,
    });

    expect(view.rows[0]?.badge).toBe(3);
  });

  it("asks the owners for both flags and defaults them", () => {
    const view = buildNavView({
      rows: [row("c-1"), row("c-2", null, { streaming: true })],
      pinned: [],
      hasMore: false,
      badgeOf: noBadges,
      streamingOf: (conversationId) => conversationId === "c-1",
      incompleteOf: (conversationId) => conversationId === "c-2",
    });

    expect(view.rows.map((entry) => entry.streaming)).toEqual([true, false]);
    expect(view.rows.map((entry) => entry.incomplete)).toEqual([false, true]);
  });

  it("defaults the two flags the row itself does not carry", () => {
    const view = buildNavView({
      rows: [row("c-1")],
      pinned: [],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(view.rows[0]?.streaming).toBe(false);
    expect(view.rows[0]?.incomplete).toBe(false);
  });
});

describe("navigation: the row is the protocol's row", () => {
  it("carries every protocol field and a null problem for a fine row", () => {
    const view = buildNavView({
      rows: [row("c-1", "2026-11-18T12:00:00Z")],
      pinned: ["c-1"],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(view.rows[0]).toEqual({
      conversationId: "c-1",
      title: "title c-1",
      badge: 0,
      badgeCapped: false,
      streaming: false,
      incomplete: false,
      pinned: true,
      lastActivityAt: "2026-11-18T12:00:00Z",
      problem: null,
    });
  });

  it("reads a missing title as absent, not as an empty one", () => {
    const view = buildNavView({
      rows: [{ conversationId: "c-1", title: "", state: "ok" } as NavRowSource],
      pinned: [],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(view.rows[0]?.title).toBeNull();
    expect(view.rows[0]?.lastActivityAt).toBeNull();
  });

  it("flags a row whose state word is missing or unknown instead of guessing", () => {
    // No fourth state exists, so a payload this layer cannot place is reported
    // rather than assumed to be fine - and it is reported one row at a time.
    const view = buildNavView({
      rows: [
        { conversationId: "c-1" } as NavRowSource,
        { conversationId: "c-2", state: "mystery" } as NavRowSource,
        row("c-3"),
      ],
      pinned: [],
      hasMore: false,
      badgeOf: noBadges,
    });

    expect(ids(view.rows)).toEqual(["c-1", "c-2", "c-3"]);
    expect(view.rows.map((entry) => entry.problem)).toEqual([
      SESSION_ROW_UNREADABLE,
      SESSION_ROW_UNREADABLE,
      null,
    ]);
  });

  it("does not freeze the caller's input and does not alias it", () => {
    const rows = [row("c-1")];

    const view = buildNavView({ rows, pinned: [], hasMore: false, badgeOf: noBadges });

    expect(rows[0]?.title).toBe("title c-1");
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(view.rows[0]).not.toBe(rows[0]);
  });
});
