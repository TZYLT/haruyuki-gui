/**
 * LocaleProvider tests.
 *
 * The provider is tested through the DOM rather than by calling hooks directly:
 * what matters is that a subtree renders in the requested language and re-renders
 * when the host changes it. A hook-level test would pass even if the provider
 * never reached a consumer.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocaleProvider, useLocale, useT } from "./provider.js";

/** A consumer that prints a translated string and the locale it saw. */
function Consumer(): React.ReactElement {
  const t = useT();
  const locale = useLocale();

  return (
    <div>
      <span data-testid="text">{t("common.action.cancel")}</span>
      {/* An interpolated key, to prove the provider reaches formatting and not
          just lookup. The key carries a placeholder rather than a plural: this
          package ships no list component, so a plural entry would be unused --
          and the plural property is asserted in plural.test.ts against messages
          built locally, which cannot pass because an entry was edited. */}
      <span data-testid="counted">{t("error.withCode", { code: "E42" })}</span>
      <span data-testid="locale">{locale}</span>
    </div>
  );
}

describe("LocaleProvider", () => {
  it("renders in English by default", () => {
    render(
      <LocaleProvider locale="en">
        <Consumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("text").textContent).toBe("Cancel");
    expect(screen.getByTestId("locale").textContent).toBe("en");
  });

  it("renders in Chinese when asked", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Consumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("text").textContent).toBe("取消");
    expect(screen.getByTestId("counted").textContent).toBe("出错了（E42）");
    expect(screen.getByTestId("locale").textContent).toBe("zh-CN");
  });

  it("normalises an unsupported tag to the fallback instead of failing", () => {
    render(
      <LocaleProvider locale="tlh">
        <Consumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("locale").textContent).toBe("en");
    expect(screen.getByTestId("text").textContent).toBe("Cancel");
  });

  it("switches language when the host re-renders with a new locale", () => {
    // There is no setLocale by design: switching is the host's re-render.
    const { rerender } = render(
      <LocaleProvider locale="en">
        <Consumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("text").textContent).toBe("Cancel");

    rerender(
      <LocaleProvider locale="zh-CN">
        <Consumer />
      </LocaleProvider>,
    );

    expect(screen.getByTestId("text").textContent).toBe("取消");
  });

  it("falls back to English outside any provider", () => {
    // A component in isolation (a unit test, a story) still renders text.
    render(<Consumer />);

    expect(screen.getByTestId("locale").textContent).toBe("en");
    expect(screen.getByTestId("text").textContent).toBe("Cancel");
  });

  it("lets two subtrees render in different locales at once", () => {
    // The reason the locale lives in context rather than a module global: a
    // preview pane next to an editing surface must be a supported arrangement.
    render(
      <div>
        <LocaleProvider locale="en">
          <span data-testid="left">
            <Consumer />
          </span>
        </LocaleProvider>
        <LocaleProvider locale="zh-CN">
          <span data-testid="right">
            <Consumer />
          </span>
        </LocaleProvider>
      </div>,
    );

    expect(screen.getByTestId("left").querySelector('[data-testid="text"]')?.textContent).toBe(
      "Cancel",
    );
    expect(screen.getByTestId("right").querySelector('[data-testid="text"]')?.textContent).toBe(
      "取消",
    );
  });
});
