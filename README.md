# PenWare

<p align="center"><img src="penware-logo.png" alt="PenWare" width="180"></p>

**Firmware watch for security research & hardware tools.**

PenWare monitors official firmware releases for popular ESP32, Flipper Zero, RF, and multi-tool devices. It keeps a baseline of the last-seen version and raises an alert when a new release appears.

- **Live app:** [https://penware.app](https://penware.app)
- **Catalog (source of truth):** [`catalog.json`](catalog.json)

> Official project links only. Only test systems you are authorized to test.

---

## Supported devices

| Device | Notes |
|--------|-------|
| **Banshee** | Wired Hatters dual-SoC (GhostESP) |
| **Biscuit Pro** | Dual-chip ESP32-C5 + WROOM |
| **Biscuit Ultra** | Pro radios + SD + external antennas |
| **Flipper Zero** | Official, Momentum, Unleashed, RogueMaster |
| **FREE-WILi 2** | RP2350B multitool |
| **HackRF Pro H4M** | Mayhem firmware |
| **Marauder V8** | ESP32 Marauder (ESP32-C5) – stable + nightly |
| **Phantom** | Rabbit Labs Phantom (CYD Marauder build) |
| **T-Embed** | LilyGO T-Embed / T-Embed CC1101 (Bruce) |
| **WiFi Pineapple Pager** | Hak5 official firmware only |

Each device entry in `catalog.json` includes:
- Firmware feeds (stable / beta / nightly where available)
- Install steps
- Recovery instructions
- Official links only

---

## Catalog

The raw catalog is always available at:

```
https://raw.githubusercontent.com/mmcoms/PenWare/main/catalog.json
```

The live app loads this file. Keep the repository public so the app (and anyone else) can fetch it.

---

## How it works

1. First scan sets a baseline for each watched feed.
2. Later scans compare the current release against the baseline.
3. A newer version raises an alert in the app.

No accounts, no telemetry, no third-party firmware sources.

---

## Project layout

| Path | What it is |
|------|------------|
| `src/components/penware/penware-app.tsx` | The whole app screen (fleet, device detail, add device, Backup) |
| `src/lib/penware/check.ts` | Server functions: `checkFeeds` (GitHub, Biscuit, Hak5 lookups) and `pullCatalog` |
| `src/components/penware/device-backup.tsx` | "Back up before you update" panel (USB flash backup for ESP32 devices) |
| `src/lib/penware/store.ts` | Saved settings, baselines and watch list (kept in the browser) |
| `catalog.json` | **The device list.** Read by the app, the firmware watch and the backup panel |
| `scripts/watch.mjs`, `.github/workflows/watch.yml` | Background firmware watch (every 6 hours, opens an issue on new releases) |

Built with TanStack Start, React, Tailwind and Vite. Hosted on Vercel.

## Running it locally

```
npm install
npm run dev
```

## Deploying

Vercel builds every push to `main` automatically (`npm run build` produces `.vercel/output`).

---

## Adding a device

`catalog.json` is the **only** place devices are defined. The app, the background firmware watch and the backup panel all read it, so a device added here appears everywhere after the next deploy (about 2 minutes).

**Quickest path**

1. Open an issue with the **New device** form (Issues → New issue → New device) and fill in what you know.
2. Turn it into a `catalog.json` entry: copy the closest existing device, change the fields below, and commit (GitHub: open `catalog.json` → pencil icon → edit → Commit changes).

**Fields**

| Field | What to put |
|---|---|
| `id` | short, lowercase, unique: `t-embed`, `marauder-v8` |
| `name`, `blurb` | display name and one-line description |
| `github` | official firmware repo URL |
| `links` | official docs / flasher links (max 8) |
| `companion` | official live UI or emulator, or `null` |
| `feeds` | one per channel to watch (see below) |
| `install`, `recovery` | steps as `{ "title": "...", "detail": "..." }`; `recoveryTitle` heads the recovery list |
| `backup` | `{ "kind": "esp32", "chips": "ESP32-S3" }` for USB backup, or `{ "kind": "checklist", "items": ["..."] }` |

**Feeds** (each needs a unique `id` and a `label`; `watchDefault: true` means watched by default and checked by the email watch):

```json
{ "id": "mydevice-stable", "label": "Stable", "watchDefault": true,
  "spec": { "kind": "github-release", "owner": "owner", "repo": "repo",
            "channel": "stable", "assetIncludes": "_myboard.bin" } }
```

`channel` is `stable` or `prerelease`. `assetIncludes` is optional and picks the file for your exact board. Firmware that isn't published as GitHub releases needs a new feed kind in `src/lib/penware/check.ts` and `scripts/watch.mjs`.

Official sources only, please.

---

## License

This project is provided as-is for personal and educational use. Firmware itself remains the property of the respective project authors.
