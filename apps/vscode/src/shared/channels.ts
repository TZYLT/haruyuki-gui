/**
 * The identifiers this shell declares to VS Code, in one place.
 *
 * VS Code resolves a contribution by name: a command id in `package.json`, the
 * id the code registers, the id the tree item points at, and the key a setting
 * is read from may all be spelled independently, and nothing checks that they
 * agree. A typo in one of them is a command that does nothing when clicked, or
 * a setting nobody reads -- reported by none of the gates.
 *
 * These constants are therefore the code side of that contract, and a test
 * reads `package.json` and compares the two. Changing a name is then one edit
 * in two places with a failing test to say when the second was forgotten.
 *
 * The frame channel names (`control`/`stream`/`bulk`) are not here: they belong
 * to the protocol package and are spelled in `core/ipc.ts`.
 */

/** Command that opens the panel. Declared in `package.json` `contributes.commands`. */
export const COMMAND_OPEN_PANEL = "haruyuki.openPanel";

/**
 * The activity-bar view. The activity-bar container itself cannot carry a
 * command, so this id is what the tree view is created with and the click
 * handler lives on the tree item.
 */
export const VIEW_LAUNCHER = "haruyuki.launcher";

/**
 * Name of the output channel.
 *
 * A display name, not an id: VS Code shows it verbatim in the Output dropdown,
 * so it is the one string a user reads.
 */
export const OUTPUT_CHANNEL_NAME = "Haruyuki";
