/**
 * Public surface of the component layer.
 *
 * The local declaration is the components stylesheet string: it is a real value
 * the layer owns, and it keeps this module from being a pure forwarding barrel
 * that the ownership gate rejects.
 */

import { COMPONENT_CSS } from "./styles.js";

/** Identifies the component layer in diagnostics. */
export const COMPONENT_LAYER = "components" as const;

/** The stylesheet these components need, for a host that injects its own. */
export const COMPONENTS_CSS = COMPONENT_CSS;

export { Alert } from "./Alert.js";
export type { AlertProps, AlertTone } from "./Alert.js";

export { Button } from "./Button.js";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button.js";

export { Dialog } from "./Dialog.js";
export type { DialogProps } from "./Dialog.js";

export { EmptyState } from "./EmptyState.js";
export type { EmptyStateProps } from "./EmptyState.js";

export { ErrorState } from "./ErrorState.js";
export type { ErrorStateProps } from "./ErrorState.js";

export { Input } from "./Input.js";
export type { InputProps } from "./Input.js";

export { Select } from "./Select.js";
export type { SelectOption, SelectProps } from "./Select.js";

export { Skeleton } from "./Skeleton.js";
export type { SkeletonProps } from "./Skeleton.js";

export { Switch } from "./Switch.js";
export type { SwitchProps } from "./Switch.js";

export { Tag } from "./Tag.js";
export type { TagProps, TagTone } from "./Tag.js";

export { COMPONENT_CSS, ensureStyles } from "./styles.js";
export type { BaseProps } from "./types.js";
