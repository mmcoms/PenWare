import { useEffect, useRef, useState } from "react";
import { Download, HardDriveDownload, Usb } from "lucide-react";
import type { Device } from "@/lib/penware/types";

/**
 * "Back up before you update" panel on each device page.
 *
 * Which panel a device gets is set by its "backup" entry in catalog.json.
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
const SLOW_KEY = "penware-backup-slow";
const STALL_MS = 30000;
const CHUNK = 256 * 1024;
// Web Serial's default receive buffer is only 255 bytes, which overflows during long
// reads and stalls them. A large buffer keeps up with the board.
const SERIAL_OPTIONS = { bufferSize: 1024 * 1024 };
const RESTORE_TOOL = "https://espressif.github.io/esptool-js/";

type EspInfo = { chips: string; note?: string };

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

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* ignore */
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

/** Backup options come from each device's "backup" entry in catalog.json. */
export function DeviceBackup({ device }: { device: Device }) {
  const backup = device.backup;
  if (backup?.kind === "esp32") return <EspBackup device={device} info={backup} />;
  if (backup?.kind === "checklist" && backup.items.length) return <Checklist items={backup.items} />;
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
  const [manualBoot, setManualBoot] = useState(false);
  const [slow, setSlow] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "serial" in navigator);
    setLog(readLog().filter((entry) => entry.deviceId === device.id));
    setSlow(readFlag(SLOW_KEY));
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
      // 460800 suits most USB-serial chips; "slow" mode stays at 115200 for boards that stall.
      const loader = new ESPLoader({
        transport,
        baudrate: slow ? 115200 : 460800,
        romBaudrate: 115200,
        serialOptions: SERIAL_OPTIONS,
      });
      setMessage("Connecting. If this hangs, hold BOOT, tap RESET, release BOOT, and try again.");
      const chip: string = await loader.main(manualBoot ? "no_reset" : "default_reset");
      const sizeLabel: string | undefined = await loader.detectFlashSize();
      const total = sizeToBytes(sizeLabel);
      if (!total) throw new Error(`Could not read the flash size (${sizeLabel ?? "unknown"}).`);

      setPhase("reading");
      setMessage(
        `${chip}, ${sizeLabel} flash. Reading${slow ? " at safe speed (can take 10+ minutes)" : ""}. Keep the cable connected.`,
      );
      let lastTick = Date.now();
      let watchdog: ReturnType<typeof setInterval> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        watchdog = setInterval(() => {
          if (Date.now() - lastTick > STALL_MS) reject(new Error("STALLED"));
        }, 2000);
      });
      // Read in 256 KB pieces: short transfers are far less likely to stall than one long one.
      const data = new Uint8Array(total);
      try {
        for (let offset = 0; offset < total; offset += CHUNK) {
          const size = Math.min(CHUNK, total - offset);
          const piece = (await Promise.race([
            loader.readFlash(offset, size, (_packet: unknown, done: number) => {
              lastTick = Date.now();
              setProgress((offset + done) / total);
            }) as Promise<Uint8Array>,
            stalled,
          ])) as Uint8Array;
          data.set(piece.subarray(0, size), offset);
          lastTick = Date.now();
          setProgress((offset + size) / total);
        }
      } finally {
        clearInterval(watchdog);
      }

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
      if (text === "STALLED") {
        writeFlag(SLOW_KEY, true);
        setSlow(true);
        setMessage(
          "Reading stopped moving. Switch the device off and unplug it, then plug it in, switch it on and try again. PenWare will use a slower, safer speed next time.",
        );
      } else if (/No port selected|requestPort/i.test(text)) {
        setMessage("No port was picked. Plug the device in with a data cable and try again.");
      } else {
        setMessage(
          `Backup failed: ${text}. Put the chip in download mode (unplug, hold BOOT, plug in, release BOOT), tick "Board is already in download mode", and try again.`,
        );
      }
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

        <div className="mt-3 flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={manualBoot}
              onChange={(event) => setManualBoot(event.target.checked)}
              disabled={running}
              className="mt-1"
            />
            <span>
              Board is already in download mode
              <span className="block text-xs text-muted">Unplug, hold BOOT, plug in, release BOOT. The screen stays dark.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={slow}
              onChange={(event) => {
                setSlow(event.target.checked);
                writeFlag(SLOW_KEY, event.target.checked);
              }}
              disabled={running}
              className="mt-1"
            />
            <span>
              Safe speed
              <span className="block text-xs text-muted">Slower but more reliable. Use it if a backup stalls.</span>
            </span>
          </label>
        </div>

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
