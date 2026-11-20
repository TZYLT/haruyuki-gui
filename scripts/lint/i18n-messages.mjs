/**
 * i18n literals lint rules.
 *
 * Two rules, both about text that should have been a message key:
 *
 * - `no-cjk-in-source`: a CJK character inside a string literal or JSX text in
 *   component source. Chinese hard-coded in a component is English-only UI with
 *   extra steps -- it renders for one locale and nothing else, and no reviewer
 *   notices because it looks like content.
 * - `no-user-facing-en`: a JSX text node or `aria-label`/`title`/`placeholder`/
 *   `alt` string containing a sentence-like English phrase. These are the exact
 *   attributes the requirement says must come from keys.
 *
 * This module is deliberately shaped as a set of `flatConfig` rule objects:
 * wiring them into `eslint.config.mjs` is a small change in that file. Keeping
 * the rules here is what lets both land without two owners editing one config.
 *
 * Why a lint rule rather than the gate script: the violation is local to one
 * expression and belongs on the line the author is typing, where it can be fixed
 * in place. A script that reports it after the fact produces a list of forty
 * findings and no way to act on any of them.
 */

/** Attributes whose value is read out or shown to the user. */
const USER_FACING_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "title",
  "placeholder",
  "alt",
]);

/** A CJK ideograph, kana, or fullwidth punctuation. */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/;

/**
 * Whether a string looks like prose rather than an identifier or a symbol.
 *
 * Requires two words and at least one space, so `"div"`, `"md"` and `"--ui-x"` are
 * left alone while `"Save changes"` is caught. A one-word English label is
 * genuinely ambiguous -- it may be a class name, a unit or a state constant -- so
 * it is not flagged. The trade favours false negatives, because a rule with many
 * false positives gets disabled wholesale and then catches nothing.
 *
 * @param value the candidate string
 * @returns whether it looks like user-facing prose
 */
function looksLikeProse(value) {
  const trimmed = value.trim();

  if (trimmed === "") return false;

  // An identifier, path, token or single word: not prose.
  if (!/\s/.test(trimmed)) return false;

  return /^[A-Za-z][A-Za-z0-9 ,.'’!?:;()%/-]*$/.test(trimmed);
}

/** The CJK rule. */
export const noCjkInSource = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hard-coded CJK text in component source; use a message key from the catalogue",
    },
    schema: [],
    messages: {
      cjk: "Hard-coded CJK text. Add a key to the catalogue and render it through t().",
    },
  },
  create(context) {
    /**
     * @param node the literal node being inspected
     */
    function checkLiteral(node) {
      if (typeof node.value === "string" && CJK.test(node.value)) {
        context.report({ node, messageId: "cjk" });
      }
    }

    return {
      Literal: checkLiteral,
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? "";

        if (CJK.test(raw)) context.report({ node, messageId: "cjk" });
      },
      // JSX text is not a Literal, so it needs its own visit.
      JSXText(node) {
        if (CJK.test(node.value)) context.report({ node, messageId: "cjk" });
      },
    };
  },
};

/** The English-prose rule. */
export const noUserFacingEn = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow user-facing English prose in JSX text and accessible-name attributes; use a message key",
    },
    schema: [],
    messages: {
      prose: "User-facing English text. Use a message key so it can be translated.",
    },
  },
  create(context) {
    return {
      JSXText(node) {
        if (CJK.test(node.value)) return;

        if (looksLikeProse(node.value)) {
          context.report({ node, messageId: "prose" });
        }
      },
      JSXAttribute(node) {
        const name = node.name?.name;

        if (typeof name !== "string" || !USER_FACING_ATTRIBUTES.has(name)) return;

        const value = node.value;

        // Only a plain string literal can be judged; an expression may be a t()
        // call, which is exactly what we want to allow.
        if (value?.type !== "Literal" || typeof value.value !== "string") return;

        if (looksLikeProse(value.value)) {
          context.report({ node: value, messageId: "prose" });
        }
      },
    };
  },
};

/**
 * The rules, keyed for `flatConfig`.
 *
 * Exported as one object so the wiring is
 * `plugins: { "haruyuki-i18n": { rules } }` rather than naming each rule twice.
 */
export const rules = {
  "no-cjk-in-source": noCjkInSource,
  "no-user-facing-en": noUserFacingEn,
};
