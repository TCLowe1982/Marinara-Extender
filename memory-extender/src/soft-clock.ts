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
import { getDataDir, assertSafeId } from "./storage.js";

// Feature flag — the conversational time-sense (narrative time-of-day + presence
// inference) is OFF by default for v1.0. It behaved well under Claude 4.6 but
// became unreliable under 4.7; held pending multi-model evaluation + user
// feedback. Set MARINARA_EXTENDER_TIMESENSE=1 to re-enable. Read at call time so
// the .env loaded by index.ts is respected. All the logic below stays intact —
// the flag only gates whether it runs and is injected.
export function timesenseEnabled(): boolean {
  return process.env.MARINARA_EXTENDER_TIMESENSE === "1";
}

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
  // Explicit presence from the user ("I'm leaving" / "I'm back"). Authoritative:
  // the user telling you they're stepping out and back means the session is NOT
  // a continuous marathon — used to keep the character from nagging about breaks.
  presence?: "present" | "away";
  awayReturns?: number;    // times the user explicitly stepped away and came back
  lastAway?: string;
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

// Explicit presence signals — read from the USER's message only. A user saying
// they're stepping out or back is authoritative and overrides any guesswork
// about how long they've "been here".
const AWAY_SIGNALS = [
  "i'm leaving", "im leaving", "i'm heading out", "heading out", "headed out",
  "gonna head out", "gotta go", "got to go", "gtg", "brb", "be right back",
  "be back", "stepping away", "stepping out", "step away", "on mobile",
  "mobile internet", "at the park", "out and about", "afk", "ttyl",
  "talk later", "talk to you later", "logging off", "going offline",
  "i'm off", "signing off", "out for a bit", "away for", "leaving for",
];
// Days that typically follow each other (used for morning-after inference).
const DAY_SEQUENCE: DayOfWeek[] = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

const EVENING_OR_LATER: TimeOfDay[] = ["evening", "night", "late_night"];

// ── Path helper ───────────────────────────────────────────────────────────────

function clockPath(chatId: string): string {
  assertSafeId(chatId); // chatId comes from request input — keep it inside the data dir
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

function isAwaySignal(text: string): boolean {
  const lower = text.toLowerCase();
  return AWAY_SIGNALS.some((s) => lower.includes(s));
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
  userText = "",
): Promise<SoftClockState> {
  const state = (await readClock(chatId)) ?? defaultClock();

  const tod = detectTimeSignal(text);
  const day = detectDaySignal(text);
  // Presence — the user's own message is authoritative. An away signal marks
  // them away; any later message (explicit "I'm back" or just resuming) means
  // they've returned, so we count the round trip and clear "away".
  let presenceChanged = false;
  if (userText) {
    if (isAwaySignal(userText)) {
      if (state.presence !== "away") presenceChanged = true;
      state.presence = "away";
      state.lastAway = userText.slice(0, 80);
    } else if (state.presence === "away") {
      state.awayReturns = (state.awayReturns ?? 0) + 1;
      state.presence = "present";
      presenceChanged = true;
    }
  }

  // The "(morning after …)" annotation should surface for exactly the turn the
  // inference fired, then clear. Without this it sticks to the context line for
  // the rest of the conversation. Track whether we (re)set it this turn.
  const hadAnnotation = state.previousSessionTimeOfDay !== undefined;
  let setAnnotationThisTurn = false;

  if (!tod && !day) {
    // No time/day signal — but still persist a presence change or retire a stale
    // annotation.
    if (presenceChanged || hadAnnotation) {
      if (hadAnnotation) delete state.previousSessionTimeOfDay;
      state.lastUpdatedAt = new Date().toISOString();
      await writeClock(chatId, state);
    }
    return state;
  }

  // Morning-after inference: if previous known state was evening/night and
  // this message signals morning, infer a day has passed.
  if (tod === "morning" && EVENING_OR_LATER.includes(state.timeOfDay)) {
    if (state.dayOfWeek !== "unknown") {
      state.dayOfWeek = nextDay(state.dayOfWeek);
    }
    state.previousSessionTimeOfDay = state.timeOfDay;
    setAnnotationThisTurn = true;
  }

  // Retire an annotation left over from a previous turn so it shows only once.
  if (hadAnnotation && !setAnnotationThisTurn) {
    delete state.previousSessionTimeOfDay;
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
  const inferred = state.previousSessionTimeOfDay
    ? ` (morning after ${state.previousSessionTimeOfDay.replace("_", " ")})`
    : "";

  // Presence note — tells the model the user controls their own time, so it
  // doesn't nag about breaks during what looks like a long session.
  let presenceNote = "";
  if (state.presence === "away") {
    presenceNote = "the user has stepped away and will return when ready";
  } else if ((state.awayReturns ?? 0) > 0) {
    presenceNote = "the user steps away and comes back on their own schedule — they manage their own time";
  }

  const bits: string[] = [];
  if (parts.length > 0) bits.push(`${parts.join(", ")}${inferred}`);
  if (presenceNote) bits.push(presenceNote);
  if (bits.length === 0) return "";
  return `Session context: ${bits.join(" · ")}`;
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
