/**
 * The renderer's error surface: does it show, does it catch, does it recover.
 *
 * Behaviour only. Appearance belongs to `ErrorState`, which has its own tests; asserting
 * styles here would be asserting them twice and disagreeing the second time.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useState, type ReactElement } from "react";

import { LocaleProvider } from "@haruyuki/ui";

import { ErrorBoundary, RendererErrorPage } from "../error-page.js";

/**
 * Wrap a tree in a provider, which every assertion here needs: the page reads its heading
 * from the catalogue, and `useT` outside a provider throws.
 *
 * @param node the tree
 * @returns the wrapped tree
 */
function withProvider(node: ReactElement): ReactElement {
  return <LocaleProvider locale="en">{node}</LocaleProvider>;
}

/** A component that throws on demand. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }): ReactElement {
  if (shouldThrow) throw new Error("the subtree exploded");

  return <p>the subtree rendered</p>;
}

describe("RendererErrorPage", () => {
  it("renders nothing when there is no error", () => {
    // A surface that appears when nothing is wrong teaches the user to ignore it.
    const { container } = render(withProvider(<RendererErrorPage error={null} />));

    expect(container.textContent).toBe("");
  });

  it("shows the translated heading and the technical detail", () => {
    render(withProvider(<RendererErrorPage error={new Error("a specific failure")} />));

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("a specific failure")).toBeTruthy();
  });

  it("renders a retry affordance only when a handler is given", () => {
    const withoutRetry = render(withProvider(<RendererErrorPage error={new Error("x")} />));

    expect(withoutRetry.queryByRole("button")).toBeNull();
    withoutRetry.unmount();

    const withRetry = render(
      withProvider(<RendererErrorPage error={new Error("x")} onRetry={() => undefined} />),
    );

    expect(withRetry.queryByRole("button")).not.toBeNull();
  });
});

describe("ErrorBoundary", () => {
  it("renders its children while nothing has thrown", () => {
    render(withProvider(<Bomb shouldThrow={false} />));

    expect(screen.getByText("the subtree rendered")).toBeTruthy();
  });

  it("catches a render throw and shows the fallback", () => {
    function Tree(): ReactElement {
      return (
        <ErrorBoundary fallback={(error) => <p>caught: {error.message}</p>}>
          <Bomb shouldThrow={true} />
        </ErrorBoundary>
      );
    }

    render(withProvider(<Tree />));

    expect(screen.getByText("caught: the subtree exploded")).toBeTruthy();
  });

  it("recovers when the fallback resets it", async () => {
    // The reset has to actually clear the failed state, or the retry button reloads the
    // same error and looks broken.
    //
    // `userEvent` rather than a bare `.click()`: React 19 batches state updates, and a
    // synthetic event fired outside React's scheduler updates the DOM write but not the
    // tree, so the assertion would read the stale fallback.
    function Tree(): ReactElement {
      const [armed, setArmed] = useState(true);

      return (
        <ErrorBoundary
          fallback={(_error, reset) => (
            <button
              type="button"
              onClick={() => {
                setArmed(false);
                reset();
              }}
            >
              try again
            </button>
          )}
        >
          <Bomb shouldThrow={armed} />
        </ErrorBoundary>
      );
    }

    render(withProvider(<Tree />));

    await userEvent.click(screen.getByRole("button", { name: "try again" }));

    expect(screen.getByText("the subtree rendered")).toBeTruthy();
  });

  it("normalises a thrown non-Error into an Error", () => {
    // A `throw "string"` is legal JavaScript and would otherwise give the fallback
    // something with no `.message`.
    function Thrower(): ReactElement {
      throw "a bare string";
    }

    function Tree(): ReactElement {
      return (
        <ErrorBoundary fallback={(error) => <p>message: {error.message}</p>}>
          <Thrower />
        </ErrorBoundary>
      );
    }

    render(withProvider(<Tree />));

    expect(screen.getByText("message: a bare string")).toBeTruthy();
  });
});
