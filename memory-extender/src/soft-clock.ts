// Conversational Soft Clock
//
// Infers time-of-day and day-of-week from conversational signals ("good morning",
// "just got home", "happy friday") without needing the system clock.
//
// State is persisted per-chat so temporal context survives across server restarts.
// The "morning-after" logic: if a previous session ended in evening/night and the
// new one opens with a morning signal, a day is inferred to have passed.

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir } from "./storage.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night" | "late_night" | "unknown";
export type DayOfWeek = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday" | "unknown";

export interface SoftClockState {
  timeOfDay: TimeOfDay;
  dayOfWeek: DayOfWeek;
  lastSignal: string;
  lastSignalTurn: number;
  lastUpdatedAt: string;   // ISO datetime
  // Used for morning-after inference
  previousSessionTimeOfDay?: TimeOfDay;
  previousSessionEndedAt?: string;  // ISO datetime
}

export interface TimeContext {
  timeOfDay: TimeOfDay;
  dayOfWeek: DayOfWeek;
  inferredFrom?: string;
}

// ── Signal tables ─────────────────────────────────────────────────────────────

const TIME_SIGNALS: Record<TimeOfDay, string[]> = {
  morning: [
    "good morning", "gm", "morning!", "just woke up", "woke up",
    "morning coffee", "breakfast", "just got up", "rise and shine",
  ],
  afternoon: [
    "good afternoon", "lunch", "lunch break", "after lunch", "lunch time",
    "lunchtime", "afternoon",
  ],
  evening: [
    "good evening", "just got home", "just got back", "after work",
    "end of the day", "long day", "dinner", "heading home", "back home",
    "home from work",
  ],
  night: [
    "good night", "heading to bed", "going to sleep", "bedtime", "about to sleep",
    "off to bed", "going to bed", "night!", "gn",
  ],
  late_night: [
    "can't sleep", "cannot sleep", "still awake", "still up", "up late",
    "late night", "couldn't sleep", "wide awake", "insomnia",
    "1am", "2am", "3am", "4am", "midnight",
  ],
  unknown: [],
};

const DAY_SIGNALS: Record<DayOfWeek, string[]> = {
  monday:    ["happy monday", "monday morning", "back to monday", "it's monday", "its monday"],
  tuesday:   ["happy tuesday", "it's tuesday", "its tuesday"],
  wednesday: ["happy wednesday", "hump day", "it's wednesday", "its wednesday"],
  thursday:  ["happy thursday", "it's thursday", "its thursday"],
  friday:    ["happy friday", "finally friday", "tgif", "it's friday", "its friday", "friday feeling", "friday!"],
  saturday:  ["happy saturday", "it's saturday", "its saturday", "saturday morning", "this saturday"],
  sunday:    ["happy sunday", "it's sunday", "its sunday", "sunday morning", "sunday evening", "sunday night"],
  unknown:   [],
};

// Days that typically follow each other (used for morning-after inference).
const DAY_SEQUENCE: DayOfWeek[] = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

const EVENING_OR_LATER: TimeOfDay[] = ["evening", "night", "late_night"];

// ── Path helper ───────────────────────────────────────────────────────────────

function clockPath(chatId: string): string {
  return join(getDataDir(), "chats", chatId, "soft-clock.yaml");
}

// ── File I/O ──────────────────────────────────────────────────────────────────

async function readClock(chatId: string): Promise<SoftClockState | null> {
  try {
    const raw = await readFile(clockPath(chatId), "utf8");
    return parseYaml(raw) as SoftClockState;
  } catch {
    return null;
  }
}

async function writeClock(chatId: string, state: SoftClockState): Promise<void> {
  const p = clockPath(chatId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, toYaml(state), "utf8");
}

function defaultClock(): SoftClockState {
  return {
    timeOfDay: "unknown",
    dayOfWeek: "unknown",
    lastSignal: "",
    lastSignalTurn: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
}

// ── Signal detection ──────────────────────────────────────────────────────────

function detectTimeSignal(text: string): TimeOfDay | null {
  const lower = text.toLowerCase();
  for (const [tod, signals] of Object.entries(TIME_SIGNALS) as [TimeOfDay, string[]][]) {
    if (tod === "unknown") continue;
    if (signals.some((s) => lower.includes(s))) return tod;
  }
  return null;
}

function detectDaySignal(text: string): DayOfWeek | null {
  const lower = text.toLowerCase();
  for (const [day, signals] of Object.entries(DAY_SIGNALS) as [DayOfWeek, string[]][]) {
    if (day === "unknown") continue;
    if (signals.some((s) => lower.includes(s))) return day;
  }
  return null;
}

function nextDay(day: DayOfWeek): DayOfWeek {
  if (day === "unknown") return "unknown";
  const idx = DAY_SEQUENCE.indexOf(day);
  return DAY_SEQUENCE[(idx + 1) % 7]!;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Process a new message and update the soft clock state.
// Call this from process-turn for each turn.
export async function updateSoftClock(
  chatId: string,
  text: string,
  turnNumber: number,
): Promise<SoftClockState> {
  const state = (await readClock(chatId)) ?? defaultClock();

  const tod = detectTimeSignal(text);
  const day = detectDaySignal(text);

  if (!tod && !day) return state; // No signal — no update.

  // Morning-after inference: if previous known state was evening/night and
  // this message signals morning, infer a day has passed.
  if (tod === "morning" && EVENING_OR_LATER.includes(state.timeOfDay)) {
    if (state.dayOfWeek !== "unknown") {
      state.dayOfWeek = nextDay(state.dayOfWeek);
    }
    state.previousSessionTimeOfDay = state.timeOfDay;
  }

  if (tod) {
    state.timeOfDay = tod;
    state.lastSignal = text.slice(0, 80);
    state.lastSignalTurn = turnNumber;
  }
  if (day) {
    state.dayOfWeek = day;
  }

  state.lastUpdatedAt = new Date().toISOString();
  await writeClock(chatId, state);
  return state;
}

// Get current soft clock state for context injection (read-only).
export async function getSoftClock(chatId: string): Promise<SoftClockState | null> {
  return readClock(chatId);
}

// Format the clock state as a short context line for the <memory> block header.
export function formatClockContext(state: SoftClockState | null): string {
  if (!state) return "";
  const parts: string[] = [];
  if (state.timeOfDay !== "unknown") {
    parts.push(state.timeOfDay.replace("_", " "));
  }
  if (state.dayOfWeek !== "unknown") {
    const cap = state.dayOfWeek[0]!.toUpperCase() + state.dayOfWeek.slice(1);
    parts.push(cap);
  }
  if (parts.length === 0) return "";
  const inferred = state.previousSessionTimeOfDay
    ? ` (morning after ${state.previousSessionTimeOfDay.replace("_", " ")})`
    : "";
  return `Session context: ${parts.join(", ")}${inferred}`;
}

// Enrich a new entry with the current time context.
export function makeTimeContext(state: SoftClockState | null): TimeContext | undefined {
  if (!state || (state.timeOfDay === "unknown" && state.dayOfWeek === "unknown")) return undefined;
  return {
    timeOfDay: state.timeOfDay,
    dayOfWeek: state.dayOfWeek,
    inferredFrom: state.lastSignal || undefined,
  };
}
