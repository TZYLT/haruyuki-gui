// Windows resolves "Core" to the real "core" directory; POSIX reports the
// specifier as unresolved. Either way a case-mismatched package path must never
// be attributed to "local" and pass silently.
import { core } from "../../Core/src/index.ts";
export const value = core;
