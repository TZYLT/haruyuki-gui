# Engine scenario command lists

One file per conversation class. Each file exports the same shape:

```js
{
  (name, description, commands);
}
```

`commands` is exactly the array `scripts/engine/record.mjs --send` reads: raw c2s
commands, sent in order, one frame each. A value written `{{<request_id>.<path>}}`
is filled by the recorder from the response to that earlier request, which is how
the `runtime` scope reaches the commands that need it. Nothing in this directory
talks to the engine itself - `record.mjs` owns spawn, token, port and cleanup, and
these files only say what to send.

Order in `index.mjs` is order of value: cheapest and most reliable first, most
likely to be blocked last.

## Record one class

The provider credential is copied by the recorder into its throwaway home; it is
never read by these scenarios and never appears in a command list.

```sh
export PATH="/c/Program Files/Git/cmd:$PATH"   # real Git first, for memfs hooks
node scripts/engine/scenarios/index.mjs --emit terminal
node scripts/engine/record.mjs \
  --scenario terminal \
  --send _research/engine-raw/terminal.cmd.json \
  --provider-auth "J:/tmp/a3-live/home/lc-local-backend/providers/auth.json" \
  --gap 300 --idle 8000
```

`--emit` writes the `--send` JSON next to the other raw artifacts under
`_research/engine-raw/` (gitignored), so a command list always has one source of
truth: the scenario module. `--out` overrides the target path, `--list` prints the
catalogue.

Per-class flags that matter:

- `--gap 8000` for `compaction`: the seed turn must finish before
  `compaction_prepare` is sent. Every other class is fine at `--gap 300`.
- `--idle 8000` for every class that includes a model turn; `terminal` and
  `memory` settle faster but the same value is harmless.
- `--auto-approve allow` for `approval`: the permission id is `perm-<toolCallId>`
  and only exists once the turn has started, so the recorder answers the
  `control_request` itself. Without the flag the same list stops at the pending
  request, and the recording then has no `turn_finished`.
- The default `--timeout 20000` is a listening window that starts after the last
  send, not a limit on the whole run; `compaction` takes about 39 s of wall time.

## What each class proves

| Class          | Status                   | Signature frames in the recording                                                                                                                                                                                                                                                                                                                  | Paid | Measured cost |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| `terminal`     | driven                   | `terminal_spawned` -> `terminal_output` (raw, no envelope) -> `terminal_exited` with `exitCode: 0`                                                                                                                                                                                                                                                 | no   | 0             |
| `memory`       | driven                   | `list_memory_response`, `read_memory_file_response`, `write_memory_file_response`, plus `memory_updated` (no envelope)                                                                                                                                                                                                                             | no   | 0             |
| `user-message` | driven                   | `input_accepted` -> `stream_delta assistant_message` -> `stream_delta usage_statistics` -> `stream_delta stop_reason: end_turn` -> `turn_finished`                                                                                                                                                                                                 | yes  | $0.00034      |
| `tool-call`    | driven                   | `stream_delta approval_request_message` (carries `tool_call`) -> `approval_classification_end` (auto-allowed) -> `client_tool_start` -> `stream_delta tool_return_message` (`status: success`, `a3-tool-ok`) -> `stop_reason: end_turn`                                                                                                            | yes  | $0.00062      |
| `approval`     | driven (recorder allows) | `update_device_status` with `current_permission_mode: "strict"` -> `approval_request_message` -> `stop_reason: requires_approval` -> `approval_classification_end` -> `control_request` with `request_id: "perm-<toolCallId>"` -> c2s `input.payload.kind: "approval_response"` -> `client_tool_start` -> `tool_return_message` -> `turn_finished` | yes  | $0.00042      |
| `subagent`     | driven                   | `launch_subagent_response` (`success: true`, `task_id`) -> seven `update_subagent_state` frames with a non-empty `subagents` array -> `stop_reason: end_turn`                                                                                                                                                                                      | yes  | $0.00327      |
| `compaction`   | driven                   | seed turn `stop_reason: end_turn` -> `compaction_prepare_response` with `success: true`, a real `prepare_id` and a `topic_report`                                                                                                                                                                                                                  | yes  | $0.00035      |

Two notes on what the frames actually are:

- `tool-call` produces no separate `tool_call_message`. The tool call arrives
  inside `approval_request_message.tool_call`, is classified automatically
  (`auto_allowed_tool_call_ids`), runs as a client tool, and comes back as a
  `tool_return_message`. That is the real 0.6.0 shape, not a missing frame.
- `approval` covers the whole round trip because the recorder answers the
  request: `--auto-approve allow` replies to the `control_request` with
  `input.payload.kind: "approval_response"`, `payload.request_id` equal to the
  `perm-<toolCallId>` value. That id is created by the model during the turn, so
  no static command list can name it; this is the one frame-derived reply the
  recorder makes. The committed recording therefore ends at `turn_finished`, and
  a run without the flag is a different (pending) recording, not a refresh of
  this one.
- `compaction` stops after `compaction_prepare` on purpose. `compaction_commit`
  needs the `prepare_id`, which the recorder can fill in as
  `{{r-4.prepare_id}}` now that prepare is known to succeed, but committing a
  compaction can also fire the merge/reflection path, and that costs more than
  this class is worth for a wire fixture.

## Cost note

The provider is a paid API, so every paid list is capped: one short turn per
class, prompts of at most 12 words, one-word replies, a single model turn per
class where possible. Measured total for the paid classes above is about
$0.0050, with `subagent` accounting for most of it because the child run carries
its own context.

Costs come from the `usage_statistics` delta in each recording
(`cost_usd`, `context_tokens`). Do not re-run a class to "refresh" a recording:
the raw files are already valid input for the redaction pass, and a second run
buys nothing but a different set of random ids.

Environment facts that each cost an attempt to rediscover, recorded here so they
are not paid for again:

1. The model id must carry the provider prefix: `deepseek/deepseek-flash`. A bare
   `deepseek-chat` fails with `Unknown model`.
2. `runtime_start.create_agent.body` only honours `model`; `llm_config` /
   `model_endpoint_type` are ignored and fall back to a placeholder model.
3. Credentials must be copied into the recorder's run root via
   `--provider-auth`; the run root overrides `HARUYUKI_HOME`, so an outer
   environment variable is not enough.
4. MemFS commits on Windows need a `PATH` whose first entry is real Git
   (`/c/Program Files/Git/cmd`), otherwise the memory class fails in a git hook.
5. Every class needs an agent and a conversation before a runtime scope exists;
   `runtime_start` with `create_agent` provides both in one frame, and
   `{{r-2.runtime.agent_id}}` / `{{r-2.agent.id}}` feed the later commands.

## Raw artifacts

Recordings land in `_research/engine-raw/` (gitignored, redaction `r0`, real
clock). One pair per class:

```
terminal.cmd.json      terminal.jsonl
memory.cmd.json        memory.jsonl
user-message.cmd.json  user-message.jsonl
tool-call.cmd.json     tool-call.jsonl
approval.cmd.json      approval.jsonl
subagent.cmd.json      subagent.jsonl
compaction.cmd.json    compaction.jsonl
```

The `.jsonl` files are the raw wire recordings handed to the redaction pass, which
rewrites them to `r1` under `fixtures/engine/recordings/`. Expectations for that
pass: agent/task/run ids, temporary `haruyuki-record-*` / `letta-background-*`
paths, the real `recordedAt` clock, and the Windows console banner text inside
`terminal_output` (which is not ASCII) all need normalising. No credential is ever
written to a recording - the recorder only copies the auth file into the run root
and deletes it with the root.
