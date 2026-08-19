// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// When did capture last actually happen? (The liveness half of the 08-04 lesson.)
//
// The poller outage ran six days because every signal that existed was a
// STATE signal ("Engine poller: off") in a place nobody looks. This is the
// EVENT signal: a timestamp written at the moment a turn is really ingested,
// surfaced on /api/health and in the memory browser header, where TC actually
// looks. A watermark advance is deliberately NOT capture — watermarks advance
// even when nothing was ingestable, which is exactly the ambiguity that let
// "running" impersonate "working".

import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { getDataDir, atomicWriteFile } from "./storage.js";

export interface CaptureStatus {
  /** ISO timestamp of the last successfully ingested turn. */
  lastCaptureAt: string;
  chatId?: string;
  characterId?: string;
  /** "live" (poller/hook) or "backfill" — so a backfill can't masquerade as live capture health. */
  source: "live" | "backfill";
}

export function captureStatusPath(): string {
  return join(getDataDir(), "capture-status.yaml");
}

/** Fire-and-forget from the ingest path — recording must never fail a turn. */
export async function recordCapture(s: Omit<CaptureStatus, "lastCaptureAt">): Promise<void> {
  try {
    const status: CaptureStatus = { lastCaptureAt: new Date().toISOString(), ...s };
    await atomicWriteFile(captureStatusPath(), toYaml(status));
  } catch (e) {
    console.warn(`[ME:capture-status] could not record — ${String(e)}`);
  }
}

export async function readCaptureStatus(): Promise<CaptureStatus | null> {
  try {
    return parseYaml(await readFile(captureStatusPath(), "utf8")) as CaptureStatus;
  } catch {
    return null;
  }
}
