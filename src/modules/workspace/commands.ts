export interface Command {
  id: string;
  label: string;
  run: () => void;
  /** Opens its own modal dialog: runs only after the palette has closed, and the palette does not restore focus. */
  opensDialog?: boolean;
}

/** Case-insensitive match of every word of the query (FR-111). */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
}
