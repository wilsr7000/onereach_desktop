/** A thin indeterminate bar along the top edge while a refresh runs with data on screen. */
export function ProgressBar({ active }: { active: boolean }): JSX.Element | null {
  if (!active) return null;
  return (
    <div className="cal-progress" role="progressbar" aria-label="Refreshing" aria-valuetext="refreshing" data-testid="cal-progress">
      <div className="cal-progress__bar" />
    </div>
  );
}
