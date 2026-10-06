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
| `src/lib/penware/catalog.ts` | Built-in device list, install steps, recovery steps |
| `src/lib/penware/store.ts` | Saved settings, baselines and watch list (kept in the browser) |
| `catalog.json` | Public catalog the app can pull from this repo |

Built with TanStack Start, React, Tailwind and Vite. Hosted on Vercel.

## Running it locally

```
npm install
npm run dev
```

## Deploying

Vercel builds every push to `main` automatically (`npm run build` produces `.vercel/output`).

---

## Contributing / Adding a device

Want to add another device?

1. Fork the repo (or open an issue).
2. Add a new object to the `devices` array in `catalog.json` following the existing structure.
3. Include at least one official feed, clear install notes, and recovery steps where possible.
4. Open a pull request.

Please stick to **official** release sources only.

---

## License

This project is provided as-is for personal and educational use. Firmware itself remains the property of the respective project authors.
