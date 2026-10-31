export type DatePhrase = "today" | "tomorrow" | "weekend" | "week";
export type CalendarDay = `${number}-${number}-${number}`;
export type WhenWindow = DatePhrase | CalendarDay;

export type DateRange = {
  startMs: number;
  endMs: number;
  phrase: WhenWindow;
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

export function calendarDate(instantMs: number, timeZone: string): string {
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  return isoDate(instantMs, zone);
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

export function isCalendarDay(value: string): value is CalendarDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() + 1 === month && utc.getUTCDate() === day;
}

export function isSingleDay(window: WhenWindow): boolean {
  return window === "today" || window === "tomorrow" || isCalendarDay(window);
}

export function windowLabel(window: WhenWindow): string {
  if (isCalendarDay(window)) return longDay(window);
  switch (window) {
    case "today":
      return "today";
    case "tomorrow":
      return "tomorrow";
    case "weekend":
      return "this weekend";
    case "week":
      return "the next seven days";
    default: {
      const neverWindow: never = window;
      return neverWindow;
    }
  }
}

export function dayRange(day: string, timeZone: string): { startMs: number; endMs: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  const startMs = zonedTime(year, month, date, 0, 0, 0, zone);
  const wall = wallClock(new Date(startMs), zone);
  if (wall.year !== year || wall.month !== month || wall.day !== date) return null;
  return { startMs, endMs: startMs + 86_400_000 };
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

export function dateRange(window: WhenWindow, nowMs: number, timeZone: string): DateRange {
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  if (isCalendarDay(window)) {
    const range = dayRange(window, zone);
    if (range) return { ...range, phrase: window };
    return dateRange("week", nowMs, zone);
  }
  switch (window) {
    case "today":
    case "tomorrow": {
      const today = wallClock(new Date(nowMs), zone);
      const day = window === "today" ? today : addDays(today, 1);
      const range = dayRange(formatDay(day), zone);
      if (range) return { ...range, phrase: window };
      const startMs = zonedTime(day.year, day.month, day.day, 0, 0, 0, zone);
      return { startMs, endMs: startMs + 86_400_000, phrase: window };
    }
    case "week":
      return { startMs: nowMs, endMs: nowMs + 7 * 86_400_000, phrase: window };
    case "weekend": {
      const today = wallClock(new Date(nowMs), zone);
      const saturday = addDays(today, daysUntilSaturday(today.weekday));
      const startMs = zonedTime(saturday.year, saturday.month, saturday.day, 0, 0, 0, zone);
      return { startMs, endMs: startMs + 2 * 86_400_000, phrase: window };
    }
    default: {
      const neverWindow: never = window;
      throw new Error(neverWindow);
    }
  }
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

export function whenInMessage(text: string, nowMs: number, timeZone: string): WhenWindow | null {
  const value = text.toLowerCase();
  const zone = isTimeZone(timeZone) ? timeZone : "Asia/Kolkata";
  const now = wallClock(new Date(nowMs), zone);
  const named = namedCalendarDay(value, now);
  if (named) return named;
  if (/(^|[^\u0900-\u097F])परसों(?![\u0900-\u097F])/.test(value)) return formatDay(addDays(now, 2));
  if (/(^|[^\u0900-\u097F])कल(?![\u0900-\u097F])/.test(value) || /\btomorrow\b/.test(value)) return "tomorrow";
  if (/(^|[^\u0900-\u097F])आज(?![\u0900-\u097F])/.test(value) || /\b(today|tonight)\b/.test(value)) return "today";
  const weekday = value.match(/\b(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/);
  const weekdayName = weekday?.[1];
  if (weekdayName && WEEKDAY_INDEX[weekdayName] != null) {
    const target = WEEKDAY_INDEX[weekdayName] ?? 0;
    const todayIndex = WEEKDAYS.indexOf(now.weekday);
    const delta = (target - todayIndex + 7) % 7;
    return formatDay(addDays(now, delta));
  }
  if (/\bweekend\b/.test(value) || value.includes("सप्ताहांत") || value.includes("वीकेंड")) return "weekend";
  if (/\b(this week|next seven days|7 days)\b/.test(value) || value.includes("इस हफ्ते") || value.includes("इस सप्ताह")) return "week";
  return null;
}

function formatDay(day: Wall): CalendarDay {
  return padDay(day.year, day.month, day.day);
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

function namedCalendarDay(value: string, now: Wall): CalendarDay | null {
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1] && isCalendarDay(iso[1])) return iso[1];
  const slash = value.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
  if (slash?.[1] && slash[2] && (slash[3] || Number(slash[1]) > 12 || Number(slash[2]) > 12)) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const rawYear = slash[3] ? Number(slash[3]) : null;
    const year = rawYear != null && rawYear < 100 ? 2000 + rawYear : rawYear;
    const parts = first > 12 && second <= 12
      ? { day: first, month: second }
      : second > 12 && first <= 12
        ? { day: second, month: first }
        : { day: first, month: second };
    const resolved = resolveDay(year, parts.month, parts.day, now);
    if (resolved) return resolved;
  }
  const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
  const dayThenMonth = value.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\b`));
  if (dayThenMonth?.[1] && dayThenMonth[2]) {
    const resolved = resolveDay(null, MONTHS[dayThenMonth[2]] ?? 0, Number(dayThenMonth[1]), now);
    if (resolved) return resolved;
  }
  const monthThenDay = value.match(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (monthThenDay?.[1] && monthThenDay[2]) {
    const resolved = resolveDay(null, MONTHS[monthThenDay[1]] ?? 0, Number(monthThenDay[2]), now);
    if (resolved) return resolved;
  }
  const ordinal = value.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal?.[1]) return upcomingDayOfMonth(Number(ordinal[1]), now);
  const tarikh = value.match(/(\d{1,2})\s*(?:तारीख|तारीख़|tarikh|tareekh)/);
  if (tarikh?.[1]) return upcomingDayOfMonth(Number(tarikh[1]), now);
  return null;
}

function resolveDay(year: number | null, month: number, day: number, now: Wall): CalendarDay | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let chosen = year ?? now.year;
  if (year == null && beforeToday(chosen, month, day, now)) chosen += 1;
  const candidate = padDay(chosen, month, day);
  return isCalendarDay(candidate) ? candidate : null;
}

function upcomingDayOfMonth(day: number, now: Wall): CalendarDay | null {
  if (day < 1 || day > 31) return null;
  let year = now.year;
  let month = now.month;
  for (let step = 0; step < 14; step += 1) {
    const candidate = padDay(year, month, day);
    if (isCalendarDay(candidate) && !beforeToday(year, month, day, now)) return candidate;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return null;
}

function beforeToday(year: number, month: number, day: number, now: Wall): boolean {
  if (year !== now.year) return year < now.year;
  if (month !== now.month) return month < now.month;
  return day < now.day;
}

function padDay(year: number, month: number, day: number): CalendarDay {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDay;
}

function longDay(day: CalendarDay): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match?.[1] || !match[2] || !match[3]) return day;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(utc);
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
