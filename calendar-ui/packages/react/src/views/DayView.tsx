import { WeekView, type WeekViewProps } from './WeekView.js';

/** The day view is the week composition with one column. */
export function DayView(props: Omit<WeekViewProps, 'density'>): JSX.Element {
  return <WeekView {...props} density="day" />;
}
