/**
 * FR-369: a Microsoft 365 sensitivity label of Confidential or higher. The relay joins the label names of a section and
 * cuts the text at 100 characters, so a cut text may hide a higher label and counts as confidential too. Shared by the
 * app's gate and the relay, which leaves such sources out one by one (server/workiqCli.ts).
 */
export function isConfidentialLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return label.length >= 100 || /confidential|secret|restricted|機密|社外秘|極秘|秘密/i.test(label);
}
