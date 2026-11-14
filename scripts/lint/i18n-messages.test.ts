/**
 * i18n lint rule tests.
 *
 * The rules are exercised through ESLint's own `Linter` rather than by rendering
 * ESLint as a subprocess: what needs proving is that the rule fires on a CJK
 * literal and on English prose, and does not fire on the identifiers that would
 * make it unusable. A subprocess test would prove the wiring instead, and the
 * wiring is one line that will be reviewed by eye.
 */

import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { noCjkInSource, noUserFacingEn } from "./i18n-messages.mjs";

/**
 * Lint a snippet with one rule.
 *
 * @param rule the rule module
 * @param ruleName name to register it under
 * @param code source to lint
 * @returns the messages ESLint produced
 */
function lint(rule, ruleName, code) {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        // A config object with no `files` key pairs with a `verify` call that has
        // no filename. Supplying both -- or neither -- silently yields zero
        // messages, which reads exactly like "the rule never fires".
        files: ["**/*.tsx", "**/*.ts"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { probe: { rules: { [ruleName]: rule } } },
        rules: { [`probe/${ruleName}`]: "error" },
      },
    ],
    // Matching the `files` pattern above. The two must agree: a config with a
    // `files` key and a filename-less call produces no messages at all.
    "probe.tsx",
  );

  // Drop the syntax-level noise so an assertion failure reads as a rule result.
  return messages.filter((message) => message.ruleId !== null);
}

describe("no-cjk-in-source", () => {
  it("reports a Chinese string literal", () => {
    const messages = lint(noCjkInSource, "no-cjk-in-source", 'const label = "保存";');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe("cjk");
  });

  it("reports Chinese JSX text", () => {
    const messages = lint(
      noCjkInSource,
      "no-cjk-in-source",
      "const A = () => <button>保存</button>;",
    );

    expect(messages).toHaveLength(1);
  });

  it("reports Chinese in a template literal", () => {
    const messages = lint(noCjkInSource, "no-cjk-in-source", "const s = `已选 ${n} 项`;");

    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows English", () => {
    const messages = lint(noCjkInSource, "no-cjk-in-source", 'const label = "Save";');

    expect(messages).toHaveLength(0);
  });

  it("allows a token name", () => {
    const messages = lint(noCjkInSource, "no-cjk-in-source", 'const t = "var(--ui-space-1)";');

    expect(messages).toHaveLength(0);
  });
});

describe("no-user-facing-en", () => {
  it("reports English prose as JSX text", () => {
    const messages = lint(
      noUserFacingEn,
      "no-user-facing-en",
      "const A = () => <p>Save changes</p>;",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe("prose");
  });

  it("reports an English aria-label", () => {
    // The attribute the requirement names explicitly: every accessible name is a
    // key, because it is translated text.
    const messages = lint(
      noUserFacingEn,
      "no-user-facing-en",
      'const A = () => <button aria-label="Close dialog" />;',
    );

    expect(messages).toHaveLength(1);
  });

  it("reports an English title and placeholder", () => {
    const title = lint(
      noUserFacingEn,
      "no-user-facing-en",
      'const A = () => <b title="Open settings" />;',
    );
    const placeholder = lint(
      noUserFacingEn,
      "no-user-facing-en",
      'const A = () => <input placeholder="Enter a value" />;',
    );

    expect(title).toHaveLength(1);
    expect(placeholder).toHaveLength(1);
  });

  it("allows a translated attribute", () => {
    // An expression is not judged: it is the t() call we are asking for.
    const messages = lint(
      noUserFacingEn,
      "no-user-facing-en",
      'const A = () => <button aria-label={t("a11y.action.close")} />;',
    );

    expect(messages).toHaveLength(0);
  });

  it("does not flag a single word", () => {
    // Ambiguous: it may be a class, a unit or a state constant. Flagging these is
    // how the rule gets disabled and stops catching anything.
    const messages = lint(noUserFacingEn, "no-user-facing-en", "const A = () => <span>md</span>;");

    expect(messages).toHaveLength(0);
  });

  it("does not flag a class name or a token", () => {
    const messages = lint(
      noUserFacingEn,
      "no-user-facing-en",
      'const A = () => <div className="ui-button caller" title="var(--ui-z-overlay)" />;',
    );

    expect(messages).toHaveLength(0);
  });

  it("leaves Chinese to the other rule", () => {
    // Two rules reporting one line is noise; CJK is the more specific finding.
    const messages = lint(noUserFacingEn, "no-user-facing-en", "const A = () => <p>保存更改</p>;");

    expect(messages).toHaveLength(0);
  });
});
