/** Ink colours (data, not text): the theme-aware 'ink' plus fixed hues that read on light and dark boards. */
export const PEN_COLORS = [
  { id: 'ink', value: 'ink' },
  { id: 'red', value: '#e5484d' },
  { id: 'blue', value: '#3e8ef7' },
  { id: 'green', value: '#30a46c' },
  { id: 'orange', value: '#f76b15' },
  { id: 'purple', value: '#8e4ec6' },
] as const;

export const HIGHLIGHTER_COLORS = [
  { id: 'yellow', value: '#ffe629' },
  { id: 'green', value: '#3dd68c' },
  { id: 'pink', value: '#ff8dc7' },
  { id: 'blue', value: '#70b8ff' },
] as const;

export const WIDTHS = { thin: 1.5, medium: 3, thick: 6 } as const;
export type WidthKey = keyof typeof WIDTHS;
export const HIGHLIGHTER_FACTOR = 6;
export const ERASER_RADIUS = 10;
