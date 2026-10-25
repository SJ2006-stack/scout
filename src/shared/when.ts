export type DatePhrase = "today" | "weekend" | "week";

export type DateRange = {
  startMs: number;
  endMs: number;
  phrase: DatePhrase;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type Weekday = (typeof WEEKDAYS)[number];

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
};

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function calendarDates(startMs: number, endMs: number, timeZone: string): string[] {
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  const dates: string[] = [];
  const seen = new Set<string>();
  for (let cursor = startMs; cursor < endMs && dates.length < 7; cursor += 86_400_000) {
    const day = isoDate(cursor, zone);
    if (seen.has(day)) continue;
    seen.add(day);
    dates.push(day);
  }
  if (dates.length === 0) dates.push(isoDate(startMs, zone));
  return dates;
}

function isoDate(instantMs: number, timeZone: string): string {
  const map: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

export function dateRange(phrase: DatePhrase, nowMs: number, timeZone: string): DateRange {
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  const today = wallClock(new Date(nowMs), zone);
  if (phrase === "today") {
    const startMs = zonedTime(today.year, today.month, today.day, 0, 0, 0, zone);
    return { startMs, endMs: startMs + 86_400_000, phrase };
  }
  if (phrase === "week") return { startMs: nowMs, endMs: nowMs + 7 * 86_400_000, phrase };
  const saturday = addDays(today, daysUntilSaturday(today.weekday));
  const startMs = zonedTime(saturday.year, saturday.month, saturday.day, 0, 0, 0, zone);
  return { startMs, endMs: startMs + 2 * 86_400_000, phrase };
}

function daysUntilSaturday(weekday: Weekday): number {
  const index = WEEKDAYS.indexOf(weekday);
  if (index === 0) return -1;
  if (index === 6) return 0;
  return 6 - index;
}

function addDays(day: Wall, days: number): Wall {
  const utc = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    weekday: WEEKDAYS[utc.getUTCDay()] ?? "Sun",
  };
}

function wallClock(instant: Date, timeZone: string): Wall {
  const map: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAYS.find((day) => day === map.weekday) ?? "Sun";
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  };
}

function offsetAt(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - instant.getTime();
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offsetAt(new Date(utc), timeZone);
    if (next === utc) return utc;
    utc = next;
  }
  return utc;
}
