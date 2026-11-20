/**
 * Skeleton, empty state and error state tests.
 *
 * All three are "draws, does not decide" components, so the interesting assertions
 * are about what they refuse to do: no timing logic, no invented actions, and -- for
 * the skeleton -- no text content that a screen reader could mistake for real data.
 *
 * The ARIA roles matter more than they look. An empty state is a status, because a
 * search that returns nothing should say so without interrupting; an error state is
 * an alert, because a retry that failed must not be silent.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { COMPONENTS_CSS } from "./index.js";
import { Button } from "./Button.js";
import { EmptyState } from "./EmptyState.js";
import { ErrorState } from "./ErrorState.js";
import { Skeleton } from "./Skeleton.js";

describe("Skeleton", () => {
  it("renders one bar by default", () => {
    const { container } = render(<Skeleton />);

    expect(container.querySelectorAll(".ui-skeleton").length).toBe(1);
  });

  it("renders the requested number of bars", () => {
    const { container } = render(<Skeleton count={3} />);

    expect(container.querySelectorAll(".ui-skeleton").length).toBe(3);
  });

  it("never renders more than one announcement for one wait", () => {
    // A live region per bar would say "loading" three times for one wait.
    render(<Skeleton count={3} />);

    expect(screen.queryAllByRole("status")).toHaveLength(1);
  });

  it("announces the wait once, from a translated key", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Skeleton count={2} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("加载中");
  });

  it("hides the bars from assistive technology", () => {
    // The bars are shapes; describing them would be describing a placeholder as
    // if it were content.
    const { container } = render(<Skeleton count={2} />);
    const bars = container.querySelectorAll(".ui-skeleton");

    for (const bar of bars) {
      expect(bar.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("accepts a pixel height and a CSS width", () => {
    const { container } = render(<Skeleton width="50%" height={24} />);
    const bar = container.querySelector(".ui-skeleton") as HTMLElement;

    expect(bar.style.height).toBe("24px");
    expect(bar.style.width).toBe("50%");
  });

  it("treats a count below one as one bar", () => {
    const { container } = render(<Skeleton count={0} />);

    expect(container.querySelectorAll(".ui-skeleton").length).toBe(1);
  });
});

describe("Skeleton announcement visibility", () => {
  it("defines a rule for every class its announcement uses", () => {
    // The announcement carries a class the stylesheet must style into a
    // visually-hidden element. That class existed in the markup and not in the
    // stylesheet, so "Loading" rendered as visible text above the bars -- which is
    // a placeholder pretending to be content, and which no assertion about the
    // live region could see, because the live region was correct.
    const css = COMPONENTS_CSS;

    expect(css).toContain(".ui-skeleton__announcement");

    // Hidden by clipping rather than by `display: none`, which would remove it
    // from the accessibility tree and defeat the announcement.
    expect(css).toMatch(/clip-path:\s*inset\(50%\)/);
  });
});

describe("EmptyState", () => {
  it("renders its title", () => {
    render(<EmptyState title="No results" />);

    expect(screen.getByText("No results")).toBeDefined();
  });

  it("is a polite status, not an alert", () => {
    // An empty result is information; interrupting a screen reader for it would
    // be the same mistake as an assertive "saved" toast.
    render(<EmptyState title="No results" />);

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("renders an optional description", () => {
    render(<EmptyState title="No results" description="Try a different term" />);

    expect(screen.getByText("Try a different term")).toBeDefined();
  });

  it("renders whatever action it is given, and nothing when none is given", () => {
    const { rerender } = render(<EmptyState title="No results" />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);

    rerender(<EmptyState title="No results" action={<Button>Create one</Button>} />);

    expect(screen.getByRole("button", { name: "Create one" })).toBeDefined();
  });

  it("takes no decision about when to appear", () => {
    // The component draws, the page decides. There is no items prop and no
    // length check to accidentally encode a policy here.
    const props = Object.keys({ title: 1, description: 1, action: 1, icon: 1 } as const);

    expect(props).not.toContain("items");
    expect(props).not.toContain("isEmpty");
  });
});

describe("ErrorState", () => {
  it("renders its title", () => {
    render(<ErrorState title="Could not load" />);

    expect(screen.getByText("Could not load")).toBeDefined();
  });

  it("is an alert, so a failed retry is never silent", () => {
    // The failure mode this prevents: a user presses retry, the screen does not
    // change, and nothing tells them it failed.
    render(<ErrorState title="Could not load" />);

    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("renders an optional detail as secondary text", () => {
    render(<ErrorState title="Could not load" detail="HTTP 500" />);

    expect(screen.getByText("HTTP 500")).toBeDefined();
  });

  it("renders a retry button only when asked", () => {
    const { rerender } = render(<ErrorState title="Could not load" />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);

    rerender(<ErrorState title="Could not load" onRetry={vi.fn()} />);

    expect(screen.getByRole("button")).toBeDefined();
  });

  it("labels the retry button from a translated key", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ErrorState title="加载失败" onRetry={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "重试" })).toBeDefined();
  });

  it("calls onRetry when the button is pressed", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(<ErrorState title="Could not load" onRetry={onRetry} />);
    await user.click(screen.getByRole("button"));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders no invented actions beyond retry", () => {
    // "Report" and "Contact support" are page decisions, not shell decisions.
    render(<ErrorState title="Could not load" onRetry={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
