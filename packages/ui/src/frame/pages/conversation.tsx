/**
 * The sample conversation page.
 *
 * The counter is the point: it is a page-local piece of state with no host
 * involvement, so a host smoke test can prove that a tab was mounted once, kept
 * its state across a layout change, and is not remounted on every save. Real
 * content would hide that signal behind scroll restoration or a message list.
 *
 * The messages are fabricated and say so in the copy, so nobody mistakes the
 * sample for a recording of a real session.
 */

import { useState } from "react";

import { Button } from "../../components/index.js";
import { useT } from "../../i18n/index.js";
import type { PageDefinition, PageInstanceProps } from "../types.js";

/** Two invented turns; enough to show a list, few enough to read at a glance. */
const SAMPLE_TURNS = [
  { speaker: "You", text: "Show me the open tasks." },
  { speaker: "Assistant", text: "Three tasks are still open." },
] as const;

/**
 * Render the sample conversation.
 *
 * @returns the conversation element with a click counter
 */
function ConversationPage(_props: PageInstanceProps) {
  const [clicks, setClicks] = useState(0);
  const t = useT();

  return (
    <section aria-label={t("page.conversation.title")}>
      <ul>
        {SAMPLE_TURNS.map((turn) => (
          <li key={turn.speaker}>
            <strong>{turn.speaker}: </strong>
            {turn.text}
          </li>
        ))}
      </ul>
      <Button onClick={() => setClicks((count) => count + 1)}>
        Clicked {clicks} {clicks === 1 ? "time" : "times"}
      </Button>
    </section>
  );
}

/** Registration for the main conversation area. */
export const conversationPage: PageDefinition = {
  id: "conversation",
  titleKey: "page.conversation.title",
  icon: "info",
  zone: "main",
  minWidth: 480,
  component: ConversationPage,
};
