/**
 * Capability IO for the `device` family.
 *
 * `device.info` is the capability probe itself: its payload carries the engine
 * version and the coarse feature flags that `availabilityOf` consumes
 * `device.setState` is untracked — no reply frame, so its
 * output is `never`.
 */

/** Permission mode as the engine spells it (`runtime-start-protocol.ts`). */
export type DevicePermissionMode = "standard" | "acceptEdits" | "unrestricted" | "strict";

/** `device.info` carries no fields beyond the envelope. */
export type DeviceInfoInput = Record<never, never>;

export interface DeviceSetStateInput {
  readonly mode?: DevicePermissionMode;
  readonly cwd?: string;
  readonly agent_id?: string | null;
  readonly conversation_id?: string | null;
}

/**
 * The coarse feature flags `app_server_info` advertises.
 *
 * The five required keys are always present; the optional ones are absent on
 * an engine that does not know them, which is exactly what turns a capability
 * into `unknown` instead of `unavailable`.
 */
export interface DeviceCapabilityFlags {
  readonly agent_management: boolean;
  readonly conversation_management: boolean;
  readonly memory_management: boolean;
  readonly runtime_start: boolean;
  readonly split_channels: boolean;
  readonly agent_free_conversations?: boolean;
  readonly launch_subagent?: boolean;
  readonly runtime_workspace_sandbox?: boolean;
  readonly runtime_external_tools_update?: boolean;
  readonly structured_outputs?: boolean;
}

export interface DeviceInfoOutput {
  readonly backend: "local" | "api";
  readonly letta_code_version: string;
  /** Wire value reported by the engine; compared with the supported version. */
  readonly protocol_version: number;
  readonly capabilities: DeviceCapabilityFlags;
}

export interface DeviceIo {
  readonly "device.info": { readonly input: DeviceInfoInput; readonly output: DeviceInfoOutput };
  /** Untracked: no request id, no reply frame, effect arrives as device status. */
  readonly "device.setState": { readonly input: DeviceSetStateInput; readonly output: never };
}
