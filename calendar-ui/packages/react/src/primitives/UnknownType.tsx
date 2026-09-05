import { isDevelopment } from '../registry.js';

/** An unregistered type never crashes: a visible placeholder in development, a neutral chip in production. */
export function UnknownType({ type, label }: { type: string; label: string }): JSX.Element {
  if (isDevelopment()) {
    return (
      <div className="cal-unknown" role="note" title={`No renderer registered for type "${type}"`}>
        <span className="cal-unknown__badge">unregistered type</span>
        <span className="cal-unknown__type">{type}</span>
      </div>
    );
  }
  return <div className="cal-chip cal-chip--neutral" title={label} aria-label={label} />;
}
