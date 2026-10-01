import type { ShiftBlock } from "@/lib/types";

// TURNS SHIFT BLOCKS INTO POSITIONED BLOCKS, for all three renderers.
//
// The grid renderers know about pixels and the server knows about instants;
// this is the only thing that knows about both. Keeping it a pure function is
// what lets the overlap rules be tested exhaustively instead of eyeballed —
// see the web AGENTS.md rule that arithmetic belongs in lib/ with a colocated
// test and component tests only cover which STATE a card selects.
//
//   shift blocks (ISO instants + the plan's zone)
//        │
//        └─ each day it touches ──▶ minutes from local midnight ──▶ top% / height%
//                                          │
//                                          └─ overlap clustering ──▶ column / columnCount
//
// There is no all-day lane any more. It served the maintenance events this
// module was derived from; a shift is always eight timed hours.
//
// MINUTES ARE READ IN THE BLOCK'S ZONE, NOT THE BROWSER'S. The server already
// resolved each shift to an instant; rendering it with the viewer's own offset
// would draw a 07:00 Jakarta shift at 00:00 for somebody in London. The block
// carries its zone precisely so the browser never has to guess.

type PositionedBlock = {
  occurrence: ShiftBlock;
  // Percentages of the day column, so the grid can be any height without this
  // module knowing the pixel scale.
  topPct: number;
  heightPct: number;
  // Which of `columnCount` side-by-side slots this block occupies. Overlapping
  // blocks share a cluster and split its width.
  column: number;
  columnCount: number;
};

type DayLayout = {
  date: string;
  timed: PositionedBlock[];
};

const MINUTES_PER_DAY = 1440;

// THE GRID IS ALWAYS 24 HOURS, even on a DST day that is really 23 or 25.
//
// A grid whose height changed twice a year would misalign every row against the
// hour labels beside it. The cost is that on a spring-forward day the 02:00 hour
// is drawn although it does not exist, and on a fall-back day the repeated hour
// is drawn once. Both are what every calendar does, and both are visibly better
// than a column of a different height from the one next to it.
const MINUTES_SCALE = MINUTES_PER_DAY;

// The smallest block the grid will draw, as a fraction of the day.
//
// A 5-minute block is 0.35% of a column — about two pixels — with a label
// inside it. Below this floor the block is unreadable, so a real shift would
// look like a rendering artefact. Every shift is eight hours today; the floor
// stays because the S3 continuation is clipped per day, and a zone whose offset
// moved could leave a sliver of one on the far side of midnight.
const MIN_HEIGHT_PCT = (15 / MINUTES_PER_DAY) * 100;

// Minutes from local midnight, in the named zone.
//
// `en-GB` with hour12:false gives a 24-hour `HH:MM`, and `hourCycle: "h23"` is
// what stops midnight coming back as 24:00 — which would place a block that
// starts the day at the bottom of the previous one.
function minutesInZone(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

// The civil date an instant falls on, in the named zone. `en-CA` because its
// short format IS YYYY-MM-DD.
function dateInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// [startMinute, endMinute) for a block AS SEEN ON `date`.
//
// A block is drawn on EVERY day it touches, clipped to that day's column:
//
//   Fri 25 column            Sat 26 column
//   ┌──────────────┐         ┌──────────────┐
//   │ 07 S1        │         │ 00 ┌───────┐ │  <- Friday's S3, continued:
//   │ 15 S2        │         │    │  S3   │ │     00:00 – 07:00 on Saturday
//   │ 23 ┌───────┐ │         │ 07 └───────┘ │
//   │    │  S3   │ │         │              │
//   └────┴───────┴─┘         └──────────────┘
//      23:00 – 24:00
//
// Shift 3 runs 23:00 to 07:00 the NEXT day, so this is not an edge case — it is
// a third of every job. Drawing it only on its business date would put one hour
// of an eight-hour shift on screen and leave Saturday morning looking idle.
function minutesOn(occurrence: ShiftBlock, date: string): { start: number; end: number } {
  const { startsAt, endsAt, timeZone } = occurrence;
  const start = dateInZone(startsAt, timeZone) === date ? minutesInZone(startsAt, timeZone) : 0;
  const end =
    dateInZone(endsAt, timeZone) === date ? minutesInZone(endsAt, timeZone) : MINUTES_SCALE;
  return { start, end: Math.max(end, start) };
}

// Greedy interval colouring.
//
// Blocks are swept in start order. A CLUSTER is a maximal run whose members all
// overlap something already in it, and every block in one cluster gets the same
// `columnCount` — which is what makes two side-by-side blocks the same width
// instead of each computing its own.
//
//   08:00 ──────────┐        cluster of 3, columnCount 3
//   09:00 ──────┐   │        ┌───┬───┬───┐
//   09:30 ──┐   │   │        │ A │ B │ C │
//           └───┴───┘        └───┴───┴───┘
//   13:00 ──────┐            separate cluster, columnCount 1
//               │            ┌───────────┐
//               └            │     D     │   <- full width, as it should be
//
// Without the cluster step, D would be drawn a third of the width because the
// widest overlap on the day was three.
function assignColumns(
  items: { occurrence: ShiftBlock; start: number; end: number }[],
): PositionedBlock[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: PositionedBlock[] = [];

  let cluster: PositionedBlock[] = [];
  // When each column becomes free again.
  let columnEnds: number[] = [];

  const closeCluster = () => {
    const width = columnEnds.length;
    for (const block of cluster) block.columnCount = width;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    // A block starting at or after every open column's end begins a new cluster:
    // nothing on screen overlaps it.
    if (columnEnds.length > 0 && columnEnds.every((end) => end <= item.start)) closeCluster();

    // First column already free, else a new one.
    let column = columnEnds.findIndex((end) => end <= item.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.end);
    } else {
      columnEnds[column] = item.end;
    }

    const topPct = (item.start / MINUTES_SCALE) * 100;
    cluster.push({
      occurrence: item.occurrence,
      topPct,
      heightPct: Math.min(
        100 - topPct,
        Math.max(MIN_HEIGHT_PCT, ((item.end - item.start) / MINUTES_SCALE) * 100),
      ),
      column,
      // Replaced when the cluster closes.
      columnCount: 1,
    });
  }
  if (cluster.length > 0) closeCluster();

  // Back into start order: the sweep emits cluster by cluster, and the DOM
  // should follow the clock so tab order and screen readers match the page.
  return out.sort((a, b) => a.topPct - b.topPct || a.column - b.column);
}

// Which blocks touch `date`, positioned in its column.
function layoutDay(occurrences: ShiftBlock[], date: string): DayLayout {
  const onDay = occurrences.filter((o) => occursOn(o, date));

  return {
    date,
    timed: assignColumns(onDay.map((o) => ({ occurrence: o, ...minutesOn(o, date) }))),
  };
}

// A block belongs to its business date, AND to every later date it runs into.
//
// The start is the block's own `occurrenceDate` — the server decided which date
// that is, in the PLAN's zone, and re-deriving it from `startsAt` in whatever
// zone this code reached for would move a shift to the previous day for a
// viewer in London.
//
// The end is the civil date `endsAt` falls on IN THE BLOCK'S ZONE, and it is
// EXCLUSIVE: one millisecond is taken off first, so a block ending exactly at
// midnight does not also claim the next day as a zero-height sliver. Friday's
// S3 ends at 07:00 Saturday, so it claims Friday and Saturday; a shift ending at
// 00:00 Saturday would claim Friday alone.
function occursOn(occurrence: ShiftBlock, date: string): boolean {
  if (date < occurrence.occurrenceDate) return false;
  if (date === occurrence.occurrenceDate) return true;
  const lastInstant = new Date(Date.parse(occurrence.endsAt) - 1).toISOString();
  return date <= dateInZone(lastInstant, occurrence.timeZone);
}

// Blocks per BUSINESS date, for the month and year grids. A plain count is all
// the Year view draws: 12 months of individual blocks is thousands of DOM nodes
// and unreadable at that scale.
//
// By business date, unlike the time grid: a month cell lists "Friday's shifts",
// and Friday's S3 is one of them wherever its clock hours land.
function countByDate(occurrences: ShiftBlock[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of occurrences) out.set(o.occurrenceDate, (out.get(o.occurrenceDate) ?? 0) + 1);
  return out;
}

// Occurrences grouped by day and ordered, for the agenda list. Days with nothing
// on them are omitted — an agenda is a list of what IS happening.
function groupByDate(occurrences: ShiftBlock[]): { date: string; items: ShiftBlock[] }[] {
  const out = new Map<string, ShiftBlock[]>();
  for (const o of occurrences) {
    const list = out.get(o.occurrenceDate);
    if (list === undefined) out.set(o.occurrenceDate, [o]);
    else list.push(o);
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, items]) => ({ date, items }));
}

// THE FULL RANGE, in the same am/pm vocabulary as everything else on screen:
// "8am – 12pm". ONE CLOCK, and that is the point — the hour gutter reading "8am"
// beside a block reading "08:00 – 12:00" makes the reader translate between two
// formats to line them up, which is work the screen should be doing.
//
// The 24-hour form is still available as `formatClockRange` for anywhere
// precision beats familiarity; nothing uses it on the calendar surface today.
function formatOccurrenceTime(occurrence: ShiftBlock): string {
  return `${formatCompactTime(occurrence)} – ${compactOf(
    minutesInZone(occurrence.endsAt, occurrence.timeZone),
  )}`;
}

// The 24-hour range, for a context that wants exactness over familiarity.
function formatClockRange(occurrence: ShiftBlock): string {
  const start = minutesInZone(occurrence.startsAt, occurrence.timeZone);
  const end = minutesInZone(occurrence.endsAt, occurrence.timeZone);
  return `${hhmm(start)} – ${hhmm(end)}`;
}

// THE START TIME ONLY, COMPACT — "8am", "9:30am", "1:15pm", "12pm".
//
// This is what a month cell shows, and the compression is the whole point: a
// row there has one line to fit a time AND a label, so "07:00 – 15:00 Shift 1 ·
// 3 lines" truncates to the time and the reader learns nothing else. Dropping
// the end time and the zero-padding buys back the characters the LABEL needs.
//
// The end time is not lost — it is in the block's tooltip and in the day and
// week views, where there is room for it.
function formatCompactTime(occurrence: ShiftBlock): string {
  return compactOf(minutesInZone(occurrence.startsAt, occurrence.timeZone));
}

// Minutes-from-midnight in the compact form. Shared by the start-only label, the
// range and the hour gutter, so all three can never drift apart.
function compactOf(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;

  // 0 -> 12am and 12 -> 12pm. `% 12` alone renders midnight and noon as "0".
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "am" : "pm";

  // ":00" is dropped, so a whole hour is "8am" rather than "8:00am".
  return minute === 0
    ? `${hour12}${suffix}`
    : `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
}

// The hour gutter's label, in that same vocabulary.
function formatHourLabel(hour24: number): string {
  return compactOf(hour24 * 60);
}

// "GMT+7", printed once above the hour gutter.
//
// It is not decoration. Every time on this screen is the PLANT's wall clock, and
// a viewer in another country reading "8am" has no way to know whose 8am it is.
// The reference prints it for the same reason.
function formatZoneOffset(timeZone: string, on: Date = new Date()): string {
  const label = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(on)
    .find((p) => p.type === "timeZoneName")?.value;
  if (label === undefined) return "";

  // `longOffset` gives "GMT+07:00", "GMT-05:00" — or a bare "GMT" at zero.
  // Parsed rather than string-patched: an earlier version stripped a leading
  // zero with a regex that also ate the sign, and rendered New York as
  // "GMT+-04". A zone is a thing people check when a time looks wrong, so it has
  // to be right in the case where it is not the local one.
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label);
  if (match === null) return "GMT+0";

  const [, sign, hours, minutes] = match;
  const hour = Number(hours);
  // Half-hour zones exist (India, Nepal); their minutes are not noise.
  return minutes === "00" ? `GMT${sign}${hour}` : `GMT${sign}${hour}:${minutes}`;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// A stable React key for one block: a job has at most one block per
// (business date, shift), and the S3 continuation on the next day is the same
// block drawn again in a different column, so the key needs no date of its own.
function blockKey(block: ShiftBlock): string {
  return `${block.jobId}-${block.occurrenceDate}-${block.shift}`;
}

export {
  MINUTES_PER_DAY,
  MIN_HEIGHT_PCT,
  assignColumns,
  blockKey,
  countByDate,
  dateInZone,
  formatClockRange,
  formatCompactTime,
  formatHourLabel,
  formatZoneOffset,
  formatOccurrenceTime,
  groupByDate,
  hhmm,
  layoutDay,
  minutesInZone,
  occursOn,
};
export type { DayLayout, PositionedBlock };
