/** Ghost bars while the first load is pending: same cell structure, a slow sheen, staggered per row. */
export function SkeletonCells({ count, perCell = 2, columns = 7, reduced }: { count: number; perCell?: number; columns?: number; reduced: boolean }): JSX.Element {
  return (
    <div className="cal-skeleton" role="status" aria-live="polite" aria-label="Loading calendar" data-testid="cal-skeleton" style={{ ['--cal-columns' as string]: String(columns) }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="cal-skeleton__cell" style={{ ['--cal-stagger' as string]: reduced ? '0ms' : `${Math.floor(i / columns) * 60}ms` }}>
          {Array.from({ length: perCell }, (_, j) => (
            <div key={j} className="cal-skeleton__bar" style={{ width: `${70 - ((i + j) % 3) * 15}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
