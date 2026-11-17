/**
 * Capability IO for the `provider` family.
 *
 * A provider command targets a store (`local`/`api`) and answers with the whole
 * store view, not the single row it changed: the caller replaces its list in one
 * go. `provider.listConnected` lists the *configured* rows.
 */

import type {
  ConnectProviderEntry,
  ConnectProviderOAuthConfig,
  ConnectProviderStorageTarget,
} from "./engine-domain.js";

export interface ProviderConnectInput {
  readonly target: ConnectProviderStorageTarget;
  readonly provider_id: string;
  readonly provider_name?: string;
  readonly auth_method_id?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly oauth_config?: ConnectProviderOAuthConfig;
}

export interface ProviderDisconnectInput {
  readonly target: ConnectProviderStorageTarget;
  readonly provider_id: string;
  readonly provider_name?: string;
}

export interface ProviderListConnectedInput {
  readonly target: ConnectProviderStorageTarget;
}

export interface ProviderConnectOutput {
  readonly target: ConnectProviderStorageTarget;
  readonly providers: readonly ConnectProviderEntry[];
  readonly models_may_have_changed: boolean;
}

export interface ProviderDisconnectOutput {
  readonly target: ConnectProviderStorageTarget;
  readonly providers: readonly ConnectProviderEntry[];
  readonly models_may_have_changed: boolean;
}

export interface ProviderListConnectedOutput {
  readonly target: ConnectProviderStorageTarget;
  readonly providers: readonly ConnectProviderEntry[];
}

export interface ProviderIo {
  readonly "provider.connect": {
    readonly input: ProviderConnectInput;
    readonly output: ProviderConnectOutput;
  };
  readonly "provider.disconnect": {
    readonly input: ProviderDisconnectInput;
    readonly output: ProviderDisconnectOutput;
  };
  readonly "provider.listConnected": {
    readonly input: ProviderListConnectedInput;
    readonly output: ProviderListConnectedOutput;
  };
}
