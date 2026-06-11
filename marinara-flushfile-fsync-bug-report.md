# Bug report: file-backed store durability is a silent no-op on Windows (fsync on read-only handle)

> Drafted for Discord verification first, then GitHub issue on Pasta-Devs/Marinara-Engine.
> Everything below was verified live on the affected machine — repro snippets included so anyone can confirm.

## TL;DR

`flushFile()` in `packages/server/src/db/file-backed-store.ts` opens files **read-only** (`openSync(path, "r")`) before calling `fsyncSync()`. On Windows, `FlushFileBuffers` requires a writable handle, so fsync fails with `EPERM` — and the empty `catch {}` swallows it. Result: the entire crash-durability chain in `atomicWriteFile()` (bak refresh fsync, tmp-file fsync, directory fsync) **never actually flushes anything on Windows**. Data only reaches disk whenever the OS lazy writer gets around to it. A hard crash (BSOD/power loss) discards the cache, and NTFS journal recovery presents the allocated-but-unwritten files as NUL-filled — **including the `.bak`**, which is exactly the double-loss scenario the code's own comments say the fsync exists to prevent.

## 30-second repro (no crash required, any Windows box)

```
node -e "const fs=require('fs');const p='t.tmp';fs.writeFileSync(p,'x');let fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);console.log('r: fsync OK')}catch(e){console.log('r: fsync FAILED',e.code)}fs.closeSync(fd);fd=fs.openSync(p,'r+');try{fs.fsyncSync(fd);console.log('r+: fsync OK')}catch(e){console.log('r+: fsync FAILED',e.code)}fs.closeSync(fd);fs.unlinkSync(p)"
```

Output on Windows (verified on Node v24.15.0, Windows 11 Pro 26200):

```
r: fsync FAILED EPERM
r+: fsync OK
```

Directory fsync (used after the rename at the end of `atomicWriteFile`) also fails with `EPERM` on Windows — directories can't be opened/flushed this way at all.

## Real-world incident that surfaced this (2026-06-10)

- Machine BSOD'd at ~23:05 (bugcheck `0x116` VIDEO_TDR_FAILURE, nvlddmkm.sys / NVIDIA driver — unrelated to Marinara) while the server was running.
- After reboot, **four files were 100% NUL bytes**: `lorebook_entries.json` (429 KB), `memory_chunks.json` (22 MB), **and both of their `.bak` files**.
- The `.bak` mtimes were 1.5–6 minutes *older* than the mains (separate save cycles) — meaning multiple minutes of wall-clock time passed without those "fsynced" bak bytes ever reaching the platter.
- Kicker: a Windows VSS shadow copy of the volume from **two days earlier** (2026-06-08) contained the *same* files also (mostly) NUL-filled — the table data had been riding the write cache across days of save cycles. The on-disk durable state was essentially never current.
- File sizes and timestamps survived (NTFS journals metadata), contents didn't (NTFS does not journal data) → classic "allocated but never flushed" zero-fill, precisely the failure mode described in the comments at `atomicWriteFile()`/`looksNulFilled()`.

All other tables survived only because they hadn't been written close to the crash, so the lazy writer had eventually flushed them.

## Root cause

```ts
// packages/server/src/db/file-backed-store.ts
function flushFile(path: string) {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");   // <-- read-only handle
    fsyncSync(fd);              // <-- EPERM on Windows (FlushFileBuffers needs write access)
  } catch {
    // Best effort only. ...    // <-- swallowed, so it LOOKS like it worked
  }
  ...
}
```

Every call site in `atomicWriteFile()` is affected:
1. `.bak` refresh: `copyFileSync → flushFile(bakTmp) → rename` — bak content never durable.
2. Main write: `writeFileSync(tmp) → flushFile(tmp) → rename` — main content never durable.
3. `flushFile(dirname(path))` — can't open a directory on Windows, also silently fails (less critical: NTFS journals the rename).

So the protection added for hard-crash NUL-fill (the `looksNulFilled` / fsync work) is shipped and present in the build, but is a no-op on the one platform that failure mode was observed on.

## Suggested fix

- Open with `"r+"` instead of `"r"` in `flushFile` (works on Windows and POSIX; verified `r+` + fsync succeeds on Windows).
- Don't swallow the error silently — log once per path or per process so a broken durability path is visible (the current `catch {}` is meant for mobile filesystems that reject fsync; logging keeps that case non-fatal while making it observable).
- The directory-fsync call can stay best-effort, but consider gating it to non-Windows since it can never succeed there.
- Optional hardening: after the first write to a table, verify-once that fsync actually succeeds and surface a startup warning if not.

## Impact

Every Windows install. Any hard crash (BSOD, power cut, hard reset) can zero the most-recently-written tables *and their backups* together. User-authored content (lorebook entries) is unrecoverable when it happens; in this incident two lorebooks were permanently lost. Until fixed, periodic profile exports are the only real safety net for Windows users.

## Environment

- Marinara Engine: source checkout, server `dist` built 2026-06-07 (contains the `looksNulFilled` fsync protection)
- Node v24.15.0, Windows 11 Pro build 26200, NTFS, NVMe SSD
