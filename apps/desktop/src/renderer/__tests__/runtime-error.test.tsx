/**
 * The runtime error page: it must explain the failure and offer exactly the
 * recovery actions the main process supports -- no "try again" on a checksum
 * mismatch, no "use bundled" when there is no external pick.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { LocaleProvider } from "@haruyuki/ui";

import { RuntimeErrorPage } from "../runtime-error.js";
import type { RuntimeFailure } from "../../shared/runtime.js";

function withProvider(node: ReactElement): ReactElement {
  return <LocaleProvider locale="en">{node}</LocaleProvider>;
}

const MISSING: RuntimeFailure = {
  kind: "missing",
  detail: "The bundled engine was not found.",
  enginePath: "C:/app/resources/engine",
  logPath: "C:/Users/x/AppData/Roaming/Haruyuki/logs",
};

describe("RuntimeErrorPage", () => {
  it("shows the missing-engine heading, path and log directory", () => {
    render(withProvider(<RuntimeErrorPage failure={MISSING} />));

    expect(screen.getByText("The bundled engine is missing")).toBeTruthy();
    expect(screen.getByText(/The bundled engine was not found/)).toBeTruthy();
    expect(screen.getByText(/C:\/app\/resources\/engine/)).toBeTruthy();
    expect(screen.getByText(/logs/)).toBeTruthy();
  });

  it("shows expected and actual hashes for an integrity failure", () => {
    render(
      withProvider(
        <RuntimeErrorPage
          failure={{
            kind: "mismatch",
            detail: "The entry hash changed.",
            expected: "a".repeat(64),
            actual: "b".repeat(64),
          }}
        />,
      ),
    );

    expect(screen.getByText("The engine failed its integrity check")).toBeTruthy();
    expect(screen.getByText(new RegExp(`Expected sha256: ${"a".repeat(64)}`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`Actual sha256: ${"b".repeat(64)}`))).toBeTruthy();
  });

  it("does not invent an action that has no handler", () => {
    render(withProvider(<RuntimeErrorPage failure={MISSING} />));

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers pick, retry, bundled and log only when their handlers exist", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onRetry = vi.fn();
    const onUseBundled = vi.fn();
    const onOpenLog = vi.fn();

    render(
      withProvider(
        <RuntimeErrorPage
          failure={MISSING}
          onPick={onPick}
          onRetry={onRetry}
          onUseBundled={onUseBundled}
          onOpenLog={onOpenLog}
        />,
      ),
    );

    await user.click(screen.getByRole("button", { name: "Choose engine folder" }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(screen.getByRole("button", { name: "Use bundled engine" }));
    await user.click(screen.getByRole("button", { name: "Open logs" }));

    expect(onPick).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onUseBundled).toHaveBeenCalledOnce();
    expect(onOpenLog).toHaveBeenCalledOnce();
  });

  it("shows the confirmed external-fallback notice when an external pick failed", () => {
    render(
      withProvider(
        <RuntimeErrorPage
          failure={{
            ...MISSING,
            externalInvalid: { dir: "D:/gone", reason: "directory missing" },
          }}
        />,
      ),
    );

    expect(
      screen.getByText(/The external engine is unavailable; using the bundled engine/),
    ).toBeTruthy();
    expect(screen.getByText(/directory missing/)).toBeTruthy();
  });
});
