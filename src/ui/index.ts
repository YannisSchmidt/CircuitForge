/**
 * The editor's own logic: commands and the editing state machine.
 *
 * Exported as a namespace from the engine barrel (`ui.Editor`, `ui.COMMANDS`) for the
 * same reason the renderer is: `Editor`, `Command` and `MenuDefinition` are interface
 * vocabulary, and a flat barrel would make `Command` ambiguous next to the CLI's.
 */

export * from './editor.js';
export * from './commands.js';
