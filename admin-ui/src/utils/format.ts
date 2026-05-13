// Format a timestamp coming from honcho's API for display in the operator's
// local timezone.
//
// honcho serializes timestamps in two slightly different ways depending on
// path:
//   - Some endpoints emit ISO strings with explicit UTC offset
//     (e.g. "2026-05-13T07:25:55.329281+00:00")
//   - Others emit naive ISO strings (no offset) for datetimes that happen
//     to be TZ-naive at the python layer (e.g. observation timestamps:
//     "2026-05-12T16:44:21")
//
// JS `new Date(...)` parses the first correctly but treats the second as
// implementation-defined (Safari historically interpreted it as local; v8
// treats it as UTC). We force the issue: any string without a TZ suffix
// gets a "Z" appended so it's unambiguously parsed as UTC — which matches
// what honcho stores. Then `toLocaleString` renders in the user's TZ.
export function formatLocalTime(iso: string): string {
  if (!iso) return "";
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasTz ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return iso; // fall back to raw input
  // YYYY-MM-DD HH:MM:SS in local time, no timezone suffix (the topbar
  // implicitly tells the operator they're looking at their own clock).
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
