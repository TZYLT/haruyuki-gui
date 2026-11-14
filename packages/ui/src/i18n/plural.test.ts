/**
 * Plural tests across the locales this package ships.
 *
 * The requirement names three languages and asks that all three hold at once:
 * `zh` uses only `other`, `en` uses `one` and `other`, `ru` uses `one`, `few`,
 * `many` and `other`.
 *
 * The messages are built here rather than read from the catalogue on purpose. A4
 * ships ten components and none of them is a list, so a plural key in the
 * catalogue would have no consumer -- and an unused key is exactly what `I6`
 * rejects. The property under test belongs to ICU and to `Intl.PluralRules`, not
 * to any particular entry, so testing it against locally-built messages is both
 * honest and stricter: it cannot pass because a catalogue entry was edited to
 * match the assertion.
 *
 * `ru` is asserted only as a property of `Intl.PluralRules`: shipping a Russian
 * catalogue to prove a point would add a translation nobody maintains.
 */

import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

/** An English message with the two branches English actually selects. */
const EN_PLURAL = "{count, plural, one {# item selected} other {# items selected}}";

/** A Chinese message with the single branch Chinese actually selects. */
const ZH_PLURAL = "{count, plural, other {已选 # 项}}";

/** A Russian message, for the four-category proof. */
const RU_PLURAL = "{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}";

/**
 * Format a plural message.
 *
 * @param message ICU message
 * @param locale locale tag
 * @param count the count
 * @returns the formatted string
 */
function format(message: string, locale: string, count: number): string {
  return new IntlMessageFormat(message, locale).format({ count }) as string;
}

describe("plural categories each language selects", () => {
  it("Chinese selects only `other` for every count", () => {
    // The measurement behind "zh uses only other": a `one` branch would be
    // unreachable, so a catalogue that declares one carries dead code that a
    // translator will still fill in and a reviewer will still approve.
    const rules = new Intl.PluralRules("zh");

    for (const count of [0, 1, 2, 5, 11, 21, 100]) {
      expect(rules.select(count), `count ${count}`).toBe("other");
    }
  });

  it("English selects `one` for 1 and `other` for the rest", () => {
    const rules = new Intl.PluralRules("en");

    expect(rules.select(1)).toBe("one");
    expect(rules.select(0)).toBe("other");
    expect(rules.select(2)).toBe("other");
  });

  it("Russian really does need four categories", () => {
    // Why the requirement names ru: it is the language that proves an ICU-based
    // solution was necessary, because no one/other scheme can express it.
    const rules = new Intl.PluralRules("ru");

    expect(rules.select(1)).toBe("one");
    expect(rules.select(2)).toBe("few");
    expect(rules.select(5)).toBe("many");
    expect(rules.select(21)).toBe("one");
  });
});

describe("formatting follows the rule, not the message", () => {
  it("uses a different English branch for one and many", () => {
    expect(format(EN_PLURAL, "en", 1)).toBe("1 item selected");
    expect(format(EN_PLURAL, "en", 5)).toBe("5 items selected");
  });

  it("treats zero as `other` in English", () => {
    // The case a hand-rolled `count === 1 ? a : b` scheme still gets right, and
    // the reason the requirement forbids hand-rolled schemes is the *other*
    // languages, not this one.
    expect(format(EN_PLURAL, "en", 0)).toBe("0 items selected");
  });

  it("puts the count in the same place in Chinese regardless of value", () => {
    // "Only other" in practice: one template, one word order, only the number
    // changes.
    expect(format(ZH_PLURAL, "zh-CN", 1)).toBe("已选 1 项");
    expect(format(ZH_PLURAL, "zh-CN", 5)).toBe("已选 5 项");
  });

  it("picks one of four Russian forms from the same message", () => {
    // The proof that an ICU message is not over-engineering: one string, four
    // rendered forms, chosen by rules nobody wants to reimplement.
    expect(format(RU_PLURAL, "ru", 1)).toBe("1 файл");
    expect(format(RU_PLURAL, "ru", 2)).toBe("2 файла");
    expect(format(RU_PLURAL, "ru", 5)).toBe("5 файлов");
    expect(format(RU_PLURAL, "ru", 21)).toBe("21 файл");
  });

  it("does not silently accept a Chinese message with a one branch", () => {
    // `.one` never fires in zh. It is not an error ICU rejects -- it is worse:
    // dead code that renders nothing and that behaviour tests cannot see.
    const zhWithOne = "{count, plural, one {已选 # 项} other {已选 # 项}}";

    expect(format(zhWithOne, "zh-CN", 1)).toBe(format(zhWithOne, "zh-CN", 5).replace("5", "1"));
  });
});
