import { useEffect, useRef, useState } from "react";
import { Download, HardDriveDownload, Usb } from "lucide-react";
import type { Device } from "@/lib/penware/types";

/**
 * "Back up before you update" panel on each device page.
 *
 * ESP32-based devices: reads the whole flash chip over USB (Web Serial +
 * Espressif's esptool-js), saves it as a .bin and records its SHA-256, so the
 * exact firmware that was on the device can be written back later.
 * Other devices: a short checklist of what to save before updating.
 *
 * esptool-js is loaded from a CDN only when a backup starts, so it adds
 * nothing to normal page loads and needs no package install.
 */

const ESPTOOL_URL = "https://cdn.jsdelivr.net/npm/esptool-js@0.7.0/+esm";
const LOG_KEY = "penware-device-backups";
const RESTORE_TOOL = "https://espressif.github.io/esptool-js/";

type EspInfo = { chips: string; note?: string };

const ESP_DEVICES: Record<string, EspInfo> = {
  banshee: {
    chips: "ESP32-S3 + ESP32-C5",
    note: "Banshee has two chips that show up as separate USB ports. Run the backup once for each chip. The file name records which chip it came from.",
  },
  "biscuit-pro": {
    chips: "ESP32-C5 + ESP32 WROOM",
    note: "Dual-chip board. If two serial ports appear, back up each one.",
  },
  "biscuit-ultra": {
    chips: "ESP32-C5 + ESP32 WROOM",
    note: "Dual-chip board. If two serial ports appear, back up each one.",
  },
  "marauder-v8": { chips: "ESP32-C5" },
  phantom: { chips: "ESP32 (CYD 2432S024)", note: "Use the USB-C port that shows a serial port, not a charge-only one." },
  "t-embed": { chips: "ESP32-S3" },
};

const CHECKLISTS: Record<string, string[]> = {
  "flipper-zero": [
    "In qFlipper, open Advanced and use Backup. It saves the Flipper's internal storage (settings, saved remotes, NFC/RFID/Sub-GHz captures) to your computer.",
    "Copy the whole microSD card to your computer as well. Custom firmware updates keep the card, but a Repair does not protect files you care about.",
    "Note which firmware you run (Official, Momentum, Unleashed or RogueMaster) so you can put it back after a Repair.",
  ],
  "hackrf-h4m-pro": [
    "Copy the whole SD card to your computer. Mayhem keeps settings, captures and apps there.",
    "Keep the hpro package of the version you run now. PenWare's channel list links the release, so you can reflash the same version if a new one misbehaves.",
  ],
  "freewili-2": [
    "Copy the SD card (apps and scripts folders) to your computer.",
    "Keep the FREE-WILi2 zip and its .sha256 for the version you run now, so you can return to it.",
  ],
  "pineapple-pager": [
    "Copy your loot and any custom payloads off the Pager (SCP over the USB network) before updating.",
    "Firmware itself always comes from the Hak5 portal. Check the SHA-256 PenWare shows against the portal before installing.",
  ],
};

type LogEntry = {
  deviceId: string;
  chip: string;
  bytes: number;
  sha256: string;
  file: string;
  at: string;
};

function readLog(): LogEntry[] {
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeLog(entries: LogEntry[]) {
  try {
    window.localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(0, 100)));
  } catch {
    /* storage blocked: the file download still happened */
  }
}

function sizeToBytes(size: string | undefined): number | null {
  const match = /^(\d+)\s*(KB|MB)$/i.exec(size ?? "");
  if (!match) return null;
  const n = Number(match[1]);
  return match[2].toUpperCase() === "MB" ? n * 1024 * 1024 : n * 1024;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function sha256Hex(data: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function saveFile(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function DeviceBackup({ device }: { device: Device }) {
  const esp = ESP_DEVICES[device.id];
  const checklist = CHECKLISTS[device.id];
  if (esp) return <EspBackup device={device} info={esp} />;
  if (checklist) return <Checklist items={checklist} />;
  return null;
}

function Checklist({ items }: { items: string[] }) {
  return (
    <section className="mt-6">
      <h2 className="font-mono text-xs tracking-widest text-lime">BACK UP BEFORE YOU UPDATE</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item} className="rounded-card border border-line bg-surface p-3 text-sm text-muted">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Phase = "idle" | "connecting" | "reading" | "done" | "error";

function EspBackup({ device, info }: { device: Device; info: EspInfo }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "serial" in navigator);
    setLog(readLog().filter((entry) => entry.deviceId === device.id));
  }, [device.id]);

  async function run() {
    if (busy.current) return;
    busy.current = true;
    setPhase("connecting");
    setProgress(0);
    setMessage("Pick the device's serial port in the browser window.");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let transport: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serial = (navigator as any).serial;
      const port = await serial.requestPort();
      const { ESPLoader, Transport } = await import(/* @vite-ignore */ ESPTOOL_URL);
      transport = new Transport(port, false);
      const loader = new ESPLoader({ transport, baudrate: 921600, romBaudrate: 115200 });
      setMessage("Connecting. If this hangs, hold BOOT, tap RESET, release BOOT, and try again.");
      const chip: string = await loader.main();
      const sizeLabel: string | undefined = await loader.detectFlashSize();
      const total = sizeToBytes(sizeLabel);
      if (!total) throw new Error(`Could not read the flash size (${sizeLabel ?? "unknown"}).`);

      setPhase("reading");
      setMessage(`${chip}, ${sizeLabel} flash. Reading. Keep the cable connected.`);
      const data: Uint8Array = await loader.readFlash(0, total, (_packet: unknown, done: number, all: number) => {
        setProgress(all ? done / all : 0);
      });

      const sha256 = await sha256Hex(data);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const chipSlug = chip.replace(/\s*\(.*\)$/, "").replace(/[^A-Za-z0-9]+/g, "-");
      const file = `penware-${device.id}-${chipSlug}-${stamp}.bin`;
      saveFile(file, data);

      const entry: LogEntry = { deviceId: device.id, chip, bytes: data.length, sha256, file, at: new Date().toISOString() };
      const all = [entry, ...readLog()];
      writeLog(all);
      setLog(all.filter((item) => item.deviceId === device.id));

      try {
        await loader.after();
      } catch {
        /* some boards need a manual reset */
      }
      setPhase("done");
      setProgress(1);
      setMessage(`Saved ${file} (${formatBytes(data.length)}). Unplug and replug the device if it stays in download mode.`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setPhase("error");
      setMessage(
        /No port selected|requestPort/i.test(text)
          ? "No port was picked. Plug the device in with a data cable and try again."
          : `Backup failed: ${text}. Put the chip in download mode (hold BOOT, tap RESET, release BOOT) and try again.`,
      );
    } finally {
      try {
        await transport?.disconnect();
      } catch {
        /* already closed */
      }
      busy.current = false;
    }
  }

  const running = phase === "connecting" || phase === "reading";

  return (
    <section className="mt-6">
      <h2 className="font-mono text-xs tracking-widest text-lime">BACK UP BEFORE YOU UPDATE</h2>
      <div className="mt-3 rounded-card border border-line bg-surface p-4">
        <p className="text-sm">
          Save an exact copy of the firmware on this {info.chips} device to your computer. If an update goes wrong,
          you can write this file back and be where you started.
        </p>
        {info.note ? <p className="mt-2 text-sm text-muted">{info.note}</p> : null}

        {supported === false ? (
          <p className="mt-3 text-sm text-alert">
            USB backup needs Chrome or Edge on a computer. Safari, Firefox and phones cannot talk to USB serial ports.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || supported === null}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-card bg-lime font-medium text-lime-ink disabled:opacity-60"
          >
            {running ? <Usb className="size-4 animate-pulse" aria-hidden="true" /> : <HardDriveDownload className="size-4" aria-hidden="true" />}
            {phase === "connecting" ? "Connecting" : phase === "reading" ? `Reading ${Math.round(progress * 100)}%` : "Connect and back up"}
          </button>
        )}

        {phase === "reading" ? (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div className="h-full bg-lime transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
        {message ? (
          <p className={`mt-3 text-sm ${phase === "error" ? "text-alert" : "text-muted"}`} aria-live="polite">
            {message}
          </p>
        ) : null}

        <details className="mt-3 text-sm text-muted">
          <summary className="cursor-pointer text-fg">How to restore a backup</summary>
          <p className="mt-2">
            Open Espressif's official web tool at{" "}
            <a href={RESTORE_TOOL} target="_blank" rel="noreferrer" className="text-lime underline">
              espressif.github.io/esptool-js
            </a>{" "}
            in Chrome or Edge, connect the same chip, choose your backup .bin, set the address to 0x0 and click Program.
            The file holds the whole chip (bootloader, partitions, app and settings), so it goes back exactly as it was.
          </p>
        </details>
      </div>

      {log.length ? (
        <div className="mt-3">
          <p className="text-xs text-muted">Backups made in this browser</p>
          <ul className="mt-2 flex flex-col gap-2">
            {log.slice(0, 5).map((entry) => (
              <li key={entry.at} className="rounded-card border border-line bg-surface p-3 text-xs">
                <p className="flex items-center gap-2 font-medium">
                  <Download className="size-3" aria-hidden="true" />
                  {entry.file}
                </p>
                <p className="mt-1 text-muted">
                  {new Date(entry.at).toLocaleString()} · {entry.chip} · {formatBytes(entry.bytes)}
                </p>
                <p className="mt-1 break-all font-mono text-muted">SHA-256 {entry.sha256}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
