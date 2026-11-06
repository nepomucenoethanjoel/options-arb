/**
 * NYSE regular session (09:30–16:00 America/New_York, Mon–Fri) with full
 * holidays and 13:00 early closes for 2026–2027 (DATA_SOURCES row 64, a
 * documented assumption from the published NYSE calendar). Outside that
 * window Olive keeps quoting its tokenized stocks while the stocks and their
 * listed options don't trade, so stock rows are headline-blocked
 * (`market_closed`). Past the calendar's coverage every day counts as closed.
 */

const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const COVERED_THROUGH = '2027-12-31';

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
});

export function isUsEquitySessionOpen(ts: number): boolean {
  const parts = Object.fromEntries(NY.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (date > COVERED_THROUGH || HOLIDAYS.has(date) || parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const close = EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  return minutes >= 9 * 60 + 30 && minutes < close;
}
