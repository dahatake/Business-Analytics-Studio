export interface Command {
  id: string;
  label: string;
  run: () => void;
}

/** Case-insensitive match of every word of the query (FR-111). */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
}
