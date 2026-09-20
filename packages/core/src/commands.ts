/**
 * The command catalog: the names a keybinding may be bound to.
 *
 * A keybinding config says `"%" = "pane.split-right"`, and something has to decide
 * whether that is a real command or a typo. That decision belongs with the config
 * schema, so the catalog lives in `core` — but the *execution* does not, because half
 * these commands are RPC calls and the other half are client-local (detach, repaint).
 * `core` therefore knows the names and what each one means, and the client knows how to
 * run them.
 *
 * herdr's equivalent is the `KeybindAction` enum in `src/input/keybindings.rs`. Its
 * names are kebab-case and scoped by subject; these keep that convention so a herdr
 * config reads recognizably here.
 */

export interface CommandSpec {
  readonly name: string
  readonly summary: string
  /** `client` commands never reach the daemon: they change this client, not the session. */
  readonly scope: 'session' | 'client'
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'pane.split-right', summary: 'Split the focused pane left/right', scope: 'session' },
  { name: 'pane.split-down', summary: 'Split the focused pane top/bottom', scope: 'session' },
  { name: 'pane.close', summary: 'Close the focused pane', scope: 'session' },
  { name: 'pane.zoom', summary: 'Toggle zoom on the focused pane', scope: 'session' },
  { name: 'pane.rename', summary: 'Rename the focused pane', scope: 'session' },
  { name: 'pane.focus-left', summary: 'Focus the pane to the left', scope: 'session' },
  { name: 'pane.focus-right', summary: 'Focus the pane to the right', scope: 'session' },
  { name: 'pane.focus-up', summary: 'Focus the pane above', scope: 'session' },
  { name: 'pane.focus-down', summary: 'Focus the pane below', scope: 'session' },
  { name: 'pane.focus-next', summary: 'Focus the next pane in layout order', scope: 'session' },
  { name: 'pane.focus-previous', summary: 'Focus the previous pane in layout order', scope: 'session' },
  { name: 'pane.resize-left', summary: 'Move the focused pane’s divider left', scope: 'session' },
  { name: 'pane.resize-right', summary: 'Move the focused pane’s divider right', scope: 'session' },
  { name: 'pane.resize-up', summary: 'Move the focused pane’s divider up', scope: 'session' },
  { name: 'pane.resize-down', summary: 'Move the focused pane’s divider down', scope: 'session' },
  { name: 'pane.swap-left', summary: 'Exchange the focused pane with the one to its left', scope: 'session' },
  { name: 'pane.swap-right', summary: 'Exchange the focused pane with the one to its right', scope: 'session' },
  { name: 'pane.swap-up', summary: 'Exchange the focused pane with the one above', scope: 'session' },
  { name: 'pane.swap-down', summary: 'Exchange the focused pane with the one below', scope: 'session' },
  { name: 'pane.scroll-up', summary: 'Scroll the focused pane back one page', scope: 'session' },
  { name: 'pane.scroll-down', summary: 'Scroll the focused pane forward one page', scope: 'session' },
  { name: 'pane.scroll-bottom', summary: 'Return the focused pane to live output', scope: 'session' },
  { name: 'tab.create', summary: 'Open a tab in the active workspace', scope: 'session' },
  { name: 'tab.close', summary: 'Close the active tab', scope: 'session' },
  { name: 'tab.next', summary: 'Focus the next tab', scope: 'session' },
  { name: 'tab.previous', summary: 'Focus the previous tab', scope: 'session' },
  { name: 'workspace.create', summary: 'Create a workspace', scope: 'session' },
  { name: 'workspace.rename', summary: 'Rename the active workspace', scope: 'session' },
  { name: 'client.settings', summary: 'Open settings: theme and agent integrations', scope: 'client' },
  { name: 'client.source-control', summary: 'Open the source control panel', scope: 'client' },
  { name: 'client.explorer', summary: 'Open the file explorer', scope: 'client' },
  { name: 'tab.rename', summary: 'Rename the active tab', scope: 'session' },
  { name: 'workspace.close', summary: 'Close the active workspace', scope: 'session' },
  { name: 'workspace.next', summary: 'Focus the next workspace', scope: 'session' },
  { name: 'workspace.previous', summary: 'Focus the previous workspace', scope: 'session' },
  { name: 'client.detach', summary: 'Detach, leaving every session running', scope: 'client' },
  { name: 'client.quit', summary: 'Close every pane and exit', scope: 'client' },
  { name: 'client.repaint', summary: 'Force a full repaint', scope: 'client' },
  { name: 'client.reload-config', summary: 'Re-read the config file', scope: 'client' },
  { name: 'client.toggle-sidebar', summary: 'Show or hide the workspace sidebar', scope: 'client' },
  { name: 'client.send-prefix', summary: 'Send the prefix key to the focused pane', scope: 'client' }
]

export type CommandName = (typeof COMMANDS)[number]['name']

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]))

export function isCommandName(value: string): boolean {
  return BY_NAME.has(value)
}

export function commandSpec(name: string): CommandSpec | null {
  return BY_NAME.get(name) ?? null
}
