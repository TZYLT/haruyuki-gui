# Content fixtures

Hand-written, synthetic inputs for the content model, one JSON file per message
or behavior class. Nothing here is a recording: every value is invented, so no
session, token, host name or real path leaks into the corpus. The engine
recordings next door are **not** reused because their redaction pass can damage
closing tags.

The loader and the exact-output assertions live in
`packages/core/src/content/fixtures.test.ts`. A fixture file is:

```json
{
  "note": "what this class proves",
  "cases": [
    {
      "name": "the test name",
      "path": "history | live-text | tools | reasoning | notice",
      "input": "...",
      "expect": "...",
      "emitted": ["optional, reasoning only"]
    }
  ]
}
```

`path` names the code path that consumes the case, and `expect` is the exact
output for that path, compared with a deep equality:

| path | consumer | `input` | `expect` |
|---|---|---|---|
| `history` | `history.parseHistoryPage` | raw history entries | `Block[]` |
| `live-text` | `adapter` + fence + `blocks` | `{ messageId, runId, frames }` | `Block[]` after the message is complete |
| `tools` | `tools.ingestToolMessage` (+ `incompleteForRun`) | `{ messages, turnFinished? }` | final `ToolCallBlock[]`, in first-seen order |
| `reasoning` | `reasoning.ingestReasoning` | `{ messages }` | final `ReasoningBlock[]`, plus `emitted` per update |
| `notice` | `notice.parseUserContent` | user `content` (string or array) | `NoticeSpan[]` |

Rules for a new case:

- one case proves one behaviour, and its `expect` must be able to fail -- an
  empty list is only allowed when the point is that nothing is produced;
- a fixture is input data, not a test helper: IDs, run IDs and message types are
  spelled out so a block snapshot can be read without running the code;
- keep values synthetic: no real path, address, host name, token or text.

The test file also enforces the cross-corpus invariants: the message classes are
each proved by a required fixture file, no prose block or notice span carries
the agent-only XML, an unknown message type always surfaces as an `unknown`
block, a call with no final return never claims success, ids stay unique, every
output survives a strict JSON round trip, and every malformed case degrades
instead of throwing. A `path` outside the table above is a load error, not a
silent fallback.
