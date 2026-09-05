/** What the core draws when a box is too short for the renderer: a coloured bar with the label as a tooltip. */
export function FallbackChip({ label, color }: { label: string; color?: string | undefined }): JSX.Element {
  return <div className="cal-chip" title={label} aria-label={label} style={color !== undefined ? { ['--cal-item-accent' as string]: color } : undefined} />;
}
