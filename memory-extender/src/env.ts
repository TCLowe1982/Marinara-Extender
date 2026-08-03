// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// .env loader.
//
// Reads sidecar/.env at startup so users can store their API key once instead
// of re-entering it in every Marinara connection form.
//
// PRECEDENCE: the shell wins. .env fills in what the environment did not set.
//
// This used to be the other way round — .env overwrote process.env
// unconditionally, to defend against stale vars leaking in from a parent shell
// or a Python venv. That defence cost the ability to configure a single run at
// all, and it failed SILENTLY: a flag passed on the command line was read and
// then replaced a moment later, with nothing logged. It is how a demo sidecar
// launched with MARINARA_EXTENDER_POLLER=0 came up polling the LIVE engine and
// rewrote a real character's lorebook from a scratch store (bkdz, caused 1akw).
// The banner even printed "disable with MARINARA_EXTENDER_POLLER=0" — advice
// the program had just made impossible to follow.
//
// The original worry is kept, but made VISIBLE instead of silently corrected:
// every shadowed key is logged, so a polluted environment announces itself
// rather than being papered over. Every key we ship is namespaced
// (MARINARA_EXTENDER_* / ME_*), which is what makes the collision risk small
// enough to trade for per-run control in the first place.
//
// Lives in its own module because index.ts binds a port at import time, so
// nothing there can be reached from a test.

import { readFile } from "fs/promises";
import { defaultEnvPath } from "./paths.js";

export async function loadDotEnv(envPath: string = defaultEnvPath()): Promise<void> {
  const shadowed: string[] = [];
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!key || !val) continue;
      if (process.env[key] !== undefined) { shadowed.push(key); continue; }
      process.env[key] = val;
    }
  } catch {
    // no .env — fine
  }
  // Keys are named, values never printed: the point is "your .env was not used
  // for these", and half of them are secrets.
  if (shadowed.length) {
    console.log(`[ME:env] taken from the environment, overriding .env: ${shadowed.join(", ")}`);
  }
  // Credentials get a louder line than flags. A shadowed flag makes the sidecar
  // behave differently and says so in the banner two lines later; a shadowed KEY
  // is invisible until a request fails somewhere else entirely, and the value
  // that wins is whatever some long-forgotten `setx` left in the user
  // environment — which is exactly the pollution case, arriving on the one
  // variable where it costs the most.
  const secrets = shadowed.filter((k) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k));
  if (secrets.length) {
    console.warn(
      `[ME:env] WARNING — credential(s) taken from the environment, NOT from .env: ${secrets.join(", ")}. ` +
        `If that is not deliberate, unset them in your shell/user environment.`,
    );
  }
}
