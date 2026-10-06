import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  Download,
  ExternalLink,
  Github,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { DeviceBackup } from "@/components/penware/device-backup";
import { BUILTIN_DEVICES } from "@/lib/penware/catalog";
import { checkFeeds, pullCatalog } from "@/lib/penware/check";
import { feedWatched, usePenware } from "@/lib/penware/store";
import type { BackupFile, Device, DeviceFeed, FeedHit, GuideStep } from "@/lib/penware/types";
import { isDevice } from "@/lib/penware/types";

type Panel = "fleet" | "device" | "add" | "vault";

type Draft = {
  id: string;
  name: string;
  blurb: string;
  github: string;
  channel: "stable" | "prerelease";
  assetIncludes: string;
  docs: string;
  companionTitle: string;
  companionHref: string;
  companionDetail: string;
  install: string;
  recovery: string;
};

const EMPTY_DRAFT: Draft = {
  id: "",
  name: "",
  blurb: "",
  github: "",
  channel: "stable",
  assetIncludes: "",
  docs: "",
  companionTitle: "",
  companionHref: "",
  companionDetail: "",
  install: "",
  recovery: "",
};

export function PenwareApp() {
  const hydrated = usePenware((state) => state.hydrated);
  const customDevices = usePenware((state) => state.customDevices);
  const hiddenIds = usePenware((state) => state.hiddenIds);
  const watch = usePenware((state) => state.watch);
  const baseline = usePenware((state) => state.baseline);
  const notified = usePenware((state) => state.notified);
  const results = usePenware((state) => state.results);
  const catalogUrl = usePenware((state) => state.catalogUrl);
  const lastScanAt = usePenware((state) => state.lastScanAt);
  const notify = usePenware((state) => state.notify);
  const applyScan = usePenware((state) => state.applyScan);
  const setWatch = usePenware((state) => state.setWatch);
  const markInstalled = usePenware((state) => state.markInstalled);
  const flagNeeded = usePenware((state) => state.flagNeeded);
  const hideBuiltin = usePenware((state) => state.hideBuiltin);
  const restoreHidden = usePenware((state) => state.restoreHidden);
  const removeCustom = usePenware((state) => state.removeCustom);
  const upsertCustom = usePenware((state) => state.upsertCustom);
  const setCatalogUrl = usePenware((state) => state.setCatalogUrl);
  const setNotify = usePenware((state) => state.setNotify);
  const mergeCustom = usePenware((state) => state.mergeCustom);
  const importBackup = usePenware((state) => state.importBackup);

  const [panel, setPanel] = useState<Panel>("fleet");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [pulling, setPulling] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | "unknown">("unknown");
  const booted = useRef(false);

  const devices = useMemo(() => {
    const hidden = new Set(hydrated ? hiddenIds : []);
    const extra = hydrated ? customDevices : [];
    return [...BUILTIN_DEVICES.filter((device) => !hidden.has(device.id)), ...extra].sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    );
  }, [hydrated, hiddenIds, customDevices]);

  const selected = devices.find((device) => device.id === selectedId) ?? null;

  useEffect(() => {
    if ("Notification" in window) setPerm(Notification.permission);
  }, []);

  useEffect(() => {
    if (!hydrated || booted.current) return;
    booted.current = true;
    const stale = !lastScanAt || Date.now() - lastScanAt > 30 * 60 * 1000;
    if (stale) void scan(usePenware.getState());
  }, [hydrated]);

  async function scan(state = usePenware.getState()) {
    const fleet = [
      ...BUILTIN_DEVICES.filter((device) => !state.hiddenIds.includes(device.id)),
      ...state.customDevices,
    ];
    const payload = fleet.flatMap((device) =>
      device.feeds
        .filter((feed) => feedWatched(state.watch, feed.id, feed.watchDefault))
        .map((feed) => ({ id: feed.id, spec: feed.spec })),
    );
    if (payload.length === 0) {
      setStatus("Nothing is being watched.");
      return;
    }
    setScanning(true);
    setStatus(`Checking ${payload.length} channels`);
    try {
      const { results: hits } = await checkFeeds({ data: payload });
      const baselineUpdates: Record<string, string> = {};
      const notifiedUpdates: Record<string, string> = {};
      const names = feedNames(fleet);
      for (const hit of hits) {
        if (!hit.ok) continue;
        const previous = state.baseline[hit.id];
        if (previous === undefined) {
          baselineUpdates[hit.id] = hit.version;
          continue;
        }
        if (previous !== hit.version && state.notified[hit.id] !== hit.version && state.notify) {
          notifiedUpdates[hit.id] = hit.version;
          const label = names.get(hit.id);
          if (label && typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(`PenWare · ${label.device}`, {
                body: `${label.feed} is now ${hit.version}`,
              });
            } catch {
              /* notification blocked */
            }
          }
        }
      }
      applyScan(hits, baselineUpdates, notifiedUpdates);
      const failed = hits.filter((hit) => !hit.ok).length;
      setStatus(failed ? `Scan finished, ${failed} channels failed` : "Scan finished");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function openDevice(id: string) {
    setSelectedId(id);
    setPanel("device");
  }

  function openAdd(device?: Device) {
    setFormError("");
    if (!device) {
      setDraft(EMPTY_DRAFT);
    } else {
      const feed = device.feeds[0];
      const spec = feed?.spec;
      setDraft({
        id: device.id,
        name: device.name,
        blurb: device.blurb,
        github: spec && spec.kind === "github-release" ? `${spec.owner}/${spec.repo}` : device.github,
        channel: spec && spec.kind === "github-release" ? spec.channel : "stable",
        assetIncludes: spec && spec.kind === "github-release" ? (spec.assetIncludes ?? "") : "",
        docs: device.links[0]?.href ?? "",
        companionTitle: device.companion?.title ?? "",
        companionHref: device.companion?.href ?? "",
        companionDetail: device.companion?.detail ?? "",
        install: device.install.map((step) => `${step.title} | ${step.detail}`).join("\n"),
        recovery: device.recovery?.map((step) => `${step.title} | ${step.detail}`).join("\n") ?? "",
      });
    }
    setPanel("add");
  }

  function saveDraft() {
    const parsed = draftToDevice(draft);
    if (typeof parsed === "string") {
      setFormError(parsed);
      return;
    }
    upsertCustom(parsed);
    setSelectedId(parsed.id);
    setPanel("device");
    setStatus(`${parsed.name} saved. Scan to read its releases.`);
  }

  async function pull() {
    const url = urlDraft.trim() || catalogUrl.trim();
    if (!url) {
      setStatus("Paste a raw GitHub catalog URL first.");
      return;
    }
    setCatalogUrl(url);
    setPulling(true);
    setStatus("Pulling catalog");
    try {
      const { devices: incoming } = await pullCatalog({ data: url });
      const builtin = new Set(BUILTIN_DEVICES.map((device) => device.id));
      const extra = incoming.filter((device) => !builtin.has(device.id));
      mergeCustom(extra);
      setStatus(
        extra.length
          ? `Merged ${extra.length} new device${extra.length === 1 ? "" : "s"}.`
          : "Connected. Those devices are already in the app, so nothing new was added.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  function onImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const body = JSON.parse(String(reader.result)) as Partial<BackupFile> & { devices?: unknown };
        if (body.penware === 1 && Array.isArray(body.customDevices)) {
          const custom = body.customDevices.filter(isDevice);
          importBackup({
            customDevices: custom,
            hiddenIds: Array.isArray(body.hiddenIds) ? body.hiddenIds.filter((id) => typeof id === "string") : [],
            watch: isRecord(body.watch) ? body.watch : {},
            baseline: isStringRecord(body.baseline) ? body.baseline : {},
            notified: isStringRecord(body.notified) ? body.notified : {},
            notify: body.notify !== false,
            catalogUrl: typeof body.catalogUrl === "string" ? body.catalogUrl : "",
          });
          setStatus("Backup restored");
          return;
        }
        const list = Array.isArray(body.devices) ? body.devices.filter(isDevice) : [];
        if (!list.length) {
          setStatus("That file has no PenWare devices");
          return;
        }
        mergeCustom(list.filter((device) => !BUILTIN_DEVICES.some((item) => item.id === device.id)));
        setStatus(`Merged ${list.length} devices`);
      } catch {
        setStatus("Could not read that file");
      }
    };
    reader.readAsText(file);
  }

  const visible = devices.filter((device) => {
    const hay = `${device.name} ${device.blurb}`.toLowerCase();
    if (query && !hay.includes(query.trim().toLowerCase())) return false;
    if (alertsOnly && alertCount(device, watch, baseline, results) === 0) return false;
    return true;
  });

  const totalAlerts = devices.reduce(
    (sum, device) => sum + alertCount(device, watch, baseline, results),
    0,
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-xl px-4 pb-16 pt-4 sm:max-w-3xl">
      <header className="sticky top-0 z-10 -mx-4 mb-4 border-b border-line bg-bg px-4 pb-3 pt-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-card bg-surface text-lime">
              <Radio className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-mono text-xs tracking-widest text-lime">PENWARE</p>
              <h1 className="text-lg font-semibold leading-tight">Firmware watch</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label={notify ? "Alerts on" : "Alerts off"} onClick={() => void toggleNotify(notify, setNotify, setPerm)}>
              {notify ? <Bell className="size-5" /> : <BellOff className="size-5" />}
            </IconButton>
            <IconButton label="Add device" onClick={() => openAdd()}>
              <Plus className="size-5" />
            </IconButton>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-card bg-lime px-4 font-medium text-lime-ink disabled:opacity-60"
          >
            <RefreshCw className={`size-4 ${scanning ? "animate-spin" : ""}`} aria-hidden="true" />
            {scanning ? "Scanning" : "Scan now"}
          </button>
          <button
            type="button"
            onClick={() => setPanel("vault")}
            className="inline-flex min-h-11 items-center justify-center rounded-card border border-line bg-surface px-4 text-sm"
          >
            Backup
          </button>
        </div>
        <p className="mt-2 min-h-5 text-sm text-muted" aria-live="polite">
          {status ||
            (totalAlerts
              ? `${totalAlerts} channel${totalAlerts === 1 ? "" : "s"} newer than your baseline`
              : "First scan sets a baseline. The next release raises an alert.")}
        </p>
      </header>

      <div className="mb-4 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fleet"
          aria-label="Search fleet"
          className="min-h-11 flex-1 rounded-card border border-line bg-surface px-3 text-fg placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => setAlertsOnly((value) => !value)}
          className={`min-h-11 rounded-card border px-3 text-sm ${alertsOnly ? "border-lime bg-lime text-lime-ink" : "border-line bg-surface text-fg"}`}
        >
          Alerts
        </button>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visible.map((device) => {
          const alerts = alertCount(device, watch, baseline, results);
          const head = headline(device, watch, results);
          return (
            <li key={device.id}>
              <button
                type="button"
                onClick={() => openDevice(device.id)}
                className={`w-full rounded-card border bg-surface px-4 py-3 text-left ${alerts ? "border-alert" : "border-line"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{device.name}</p>
                    <p className="mt-1 text-sm text-muted">{device.blurb}</p>
                  </div>
                  {alerts > 0 ? (
                    <span className="rounded-full bg-alert px-2 py-1 font-mono text-xs text-fg">{alerts} new</span>
                  ) : null}
                </div>
                <p className={`mt-3 font-mono text-sm ${head.bad ? "text-alert" : "text-lime"}`}>{head.text}</p>
              </button>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 ? (
        <p className="mt-8 text-center text-sm text-muted">No devices match.</p>
      ) : null}
      <p className="mt-8 text-center text-xs text-muted">
        Official project links only. Test systems you are allowed to test.
        {perm === "denied" ? " Browser alerts are blocked." : ""}
      </p>

      {panel === "device" && selected ? (
        <Sheet title={selected.name} onBack={() => setPanel("fleet")}>
          <p className="text-sm text-muted">{selected.blurb}</p>
          <section className="mt-5">
            <h2 className="font-mono text-xs tracking-widest text-lime">CHANNELS</h2>
            <ul className="mt-3 flex flex-col gap-3">
              {selected.feeds.map((feed) => (
                <FeedRow
                  key={feed.id}
                  feed={feed}
                  hit={results[feed.id]}
                  watched={feedWatched(watch, feed.id, feed.watchDefault)}
                  alert={isAlert(feed.id, baseline, results)}
                  onWatch={(value) => setWatch(feed.id, value)}
                  onInstalled={(version) => markInstalled(feed.id, version)}
                  onNeeded={() => flagNeeded(feed.id)}
                />
              ))}
            </ul>
          </section>
          <DeviceBackup device={selected} />
          <Steps title="Install" steps={selected.install} />
          {selected.recovery && selected.recoveryTitle ? (
            <Steps title={selected.recoveryTitle} steps={selected.recovery} />
          ) : (
            <section className="mt-6">
              <h2 className="font-mono text-xs tracking-widest text-lime">RECOVERY</h2>
              <p className="mt-2 text-sm text-muted">No DFU or download-mode path for this device.</p>
            </section>
          )}
          <section className="mt-6">
            <h2 className="font-mono text-xs tracking-widest text-lime">EMULATOR</h2>
            {selected.companion ? (
              <a
                href={selected.companion.href}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block rounded-card border border-line bg-surface p-4"
              >
                <p className="font-medium">{selected.companion.title}</p>
                <p className="mt-1 text-sm text-muted">{selected.companion.detail}</p>
              </a>
            ) : (
              <p className="mt-2 text-sm text-muted">No official emulator for this device.</p>
            )}
          </section>
          <section className="mt-6">
            <h2 className="font-mono text-xs tracking-widest text-lime">LINKS</h2>
            <div className="mt-3 flex flex-col gap-2">
              <a
                href={selected.github}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-card border border-line bg-surface px-4 text-sm"
              >
                <Github className="size-4 text-lime" aria-hidden="true" />
                GitHub
                <ExternalLink className="ml-auto size-4 text-muted" aria-hidden="true" />
              </a>
              {selected.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-card border border-line bg-surface px-4 text-sm"
                >
                  {link.label}
                  <ExternalLink className="ml-auto size-4 text-muted" aria-hidden="true" />
                </a>
              ))}
            </div>
          </section>
          <div className="mt-6 flex gap-2">
            {customDevices.some((device) => device.id === selected.id) ? (
              <>
                <button
                  type="button"
                  onClick={() => openAdd(selected)}
                  className="min-h-11 flex-1 rounded-card border border-line bg-surface"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    removeCustom(selected.id);
                    setPanel("fleet");
                  }}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-card border border-line px-4 text-alert"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  hideBuiltin(selected.id);
                  setPanel("fleet");
                }}
                className="min-h-11 flex-1 rounded-card border border-line bg-surface text-sm"
              >
                Hide from fleet
              </button>
            )}
          </div>
        </Sheet>
      ) : null}

      {panel === "add" ? (
        <Sheet title={draft.id ? "Edit device" : "Add device"} onBack={() => setPanel(selected ? "device" : "fleet")}>
          <p className="text-sm text-muted">
            New hardware is watched from GitHub releases. One step per line. Use Title | what to do.
          </p>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraft();
            }}
          >
            <Field label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
            <Field label="Short note" value={draft.blurb} onChange={(blurb) => setDraft({ ...draft, blurb })} />
            <Field
              label="GitHub repo"
              value={draft.github}
              onChange={(github) => setDraft({ ...draft, github })}
              placeholder="owner/repo"
            />
            <label className="block text-sm">
              <span className="text-muted">Channel</span>
              <select
                value={draft.channel}
                onChange={(event) =>
                  setDraft({ ...draft, channel: event.target.value === "prerelease" ? "prerelease" : "stable" })
                }
                className="mt-1 min-h-11 w-full rounded-card border border-line bg-surface px-3"
              >
                <option value="stable">Stable releases</option>
                <option value="prerelease">Nightly / prerelease</option>
              </select>
            </label>
            <Field
              label="Asset name contains"
              value={draft.assetIncludes}
              onChange={(assetIncludes) => setDraft({ ...draft, assetIncludes })}
              placeholder="optional, e.g. _v8.bin"
            />
            <Field
              label="Docs URL"
              value={draft.docs}
              onChange={(docs) => setDraft({ ...draft, docs })}
              placeholder="https://"
            />
            <Field
              label="Official emulator title"
              value={draft.companionTitle}
              onChange={(companionTitle) => setDraft({ ...draft, companionTitle })}
              placeholder="Leave blank if none"
            />
            <Field
              label="Emulator URL"
              value={draft.companionHref}
              onChange={(companionHref) => setDraft({ ...draft, companionHref })}
            />
            <Area
              label="What the emulator is"
              value={draft.companionDetail}
              onChange={(companionDetail) => setDraft({ ...draft, companionDetail })}
            />
            <Area label="Install steps" value={draft.install} onChange={(install) => setDraft({ ...draft, install })} />
            <Area
              label="DFU or download mode"
              value={draft.recovery}
              onChange={(recovery) => setDraft({ ...draft, recovery })}
            />
            {formError ? <p className="text-sm text-alert">{formError}</p> : null}
            <button type="submit" className="min-h-11 rounded-card bg-lime font-medium text-lime-ink">
              Save device
            </button>
          </form>
        </Sheet>
      ) : null}

      {panel === "vault" ? (
        <Sheet title="Backup" onBack={() => setPanel("fleet")}>
          <p className="text-sm text-muted">
            The app keeps your fleet on this device. A GitHub repo is the backup you can edit when new hardware
            shows up. Private repos cannot be pulled from here. Make the repo public, or import the file.
          </p>
          <label className="mt-4 block text-sm">
            <span className="text-muted">Catalog URL</span>
            <input
              value={urlDraft || catalogUrl}
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder="https://raw.githubusercontent.com/you/PenWare/main/catalog.json"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="mt-1 min-h-11 w-full rounded-card border border-line bg-surface px-3 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            onClick={() => void pull()}
            disabled={pulling}
            className="mt-3 min-h-11 w-full rounded-card bg-lime font-medium text-lime-ink disabled:opacity-60"
          >
            {pulling ? "Pulling" : "Pull catalog"}
          </button>
          {status ? <p className="mt-3 text-sm text-lime">{status}</p> : null}
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() =>
                download(
                  "catalog.json",
                  JSON.stringify({ penwareCatalog: 1, devices: customDevices }, null, 2),
                )
              }
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-card border border-line bg-surface"
            >
              <Download className="size-4" aria-hidden="true" />
              Download catalog.json
            </button>
            <button
              type="button"
              onClick={() => download("README.md", README)}
              className="min-h-11 rounded-card border border-line bg-surface text-sm"
            >
              Download repo README
            </button>
            <button
              type="button"
              onClick={() => {
                const file: BackupFile = {
                  penware: 1,
                  exportedAt: new Date().toISOString(),
                  catalogUrl,
                  customDevices,
                  hiddenIds,
                  watch,
                  baseline,
                  notified,
                  notify,
                };
                download("penware-backup.json", JSON.stringify(file, null, 2));
              }}
              className="min-h-11 rounded-card border border-line bg-surface text-sm"
            >
              Download full backup
            </button>
            <label className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-card border border-line bg-surface text-sm">
              Import backup or catalog
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onImport(file);
                  event.target.value = "";
                }}
              />
            </label>
            {hiddenIds.length > 0 ? (
              <button
                type="button"
                onClick={restoreHidden}
                className="min-h-11 rounded-card border border-line text-sm"
              >
                Restore hidden devices
              </button>
            ) : null}
          </div>
          <p className="mt-4 text-xs text-muted">
            Commit catalog.json on main as PenWare. In the app, paste the raw link and pull. Builtin devices stay in
            the app. The file is how you add the next radio.
          </p>
        </Sheet>
      ) : null}
    </main>
  );
}

function FeedRow({
  feed,
  hit,
  watched,
  alert,
  onWatch,
  onInstalled,
  onNeeded,
}: {
  feed: DeviceFeed;
  hit: FeedHit | undefined;
  watched: boolean;
  alert: boolean;
  onWatch: (value: boolean) => void;
  onInstalled: (version: string) => void;
  onNeeded: () => void;
}) {
  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{feed.label}</p>
          <p className="font-mono text-sm text-lime">
            {hit && hit.ok ? hit.version : hit && !hit.ok ? hit.error : "Not checked"}
          </p>
          {hit && hit.ok && hit.publishedAt ? (
            <p className="mt-1 text-xs text-muted">{formatWhen(hit.publishedAt)}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onWatch(!watched)}
          className={`min-h-11 rounded-card px-3 text-sm ${watched ? "bg-lime text-lime-ink" : "border border-line"}`}
        >
          {watched ? "Watching" : "Off"}
        </button>
      </div>
      {alert ? <p className="mt-2 text-sm text-alert">Newer than the version you marked installed.</p> : null}
      {hit && hit.ok && hit.note ? <p className="mt-2 text-xs text-muted">{hit.note}</p> : null}
      {hit && hit.ok ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={hit.url} target="_blank" rel="noreferrer" className="text-sm text-lime">
            Release
          </a>
          {hit.fileUrl ? (
            <a href={hit.fileUrl} target="_blank" rel="noreferrer" className="text-sm text-lime">
              {hit.fileName ?? "File"}
            </a>
          ) : null}
          <button type="button" onClick={() => onInstalled(hit.version)} className="inline-flex items-center gap-1 text-sm">
            <Check className="size-4" aria-hidden="true" />
            Mark installed
          </button>
          <button type="button" onClick={onNeeded} className="text-sm text-muted">
            Flag as needed
          </button>
        </div>
      ) : null}
    </li>
  );
}

function Steps({ title, steps }: { title: string; steps: GuideStep[] }) {
  return (
    <section className="mt-6">
      <h2 className="font-mono text-xs tracking-widest text-lime">{title.toUpperCase()}</h2>
      <ol className="mt-3 flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={`${step.title}-${index}`} className="grid grid-cols-[2.5rem_1fr] gap-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-surface-2 font-mono text-sm text-lime">
              {index + 1}
            </span>
            <div>
              <p className="font-medium">{step.title}</p>
              <p className="mt-1 text-sm text-muted">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Sheet({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-bg">
      <div className="mx-auto min-h-screen w-full max-w-xl px-4 pb-16 pt-4">
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-2 text-sm text-lime">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Fleet
        </button>
        <h2 className="mt-2 text-2xl font-semibold">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-11 items-center justify-center rounded-card border border-line bg-surface"
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-11 w-full rounded-card border border-line bg-surface px-3"
      />
    </label>
  );
}

function Area({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2"
      />
    </label>
  );
}

function alertCount(
  device: Device,
  watch: Record<string, boolean>,
  baseline: Record<string, string>,
  results: Record<string, FeedHit>,
) {
  return device.feeds.filter(
    (feed) => feedWatched(watch, feed.id, feed.watchDefault) && isAlert(feed.id, baseline, results),
  ).length;
}

function isAlert(feedId: string, baseline: Record<string, string>, results: Record<string, FeedHit>) {
  const hit = results[feedId];
  if (!hit || !hit.ok) return false;
  const known = baseline[feedId];
  return known !== undefined && known !== hit.version;
}

function headline(device: Device, watch: Record<string, boolean>, results: Record<string, FeedHit>) {
  const feeds = device.feeds.filter((feed) => feedWatched(watch, feed.id, feed.watchDefault));
  const hit = feeds.map((feed) => results[feed.id]).find((item) => item?.ok);
  if (hit && hit.ok) return { text: hit.version, bad: false };
  const failed = feeds.map((feed) => results[feed.id]).find((item) => item && !item.ok);
  if (failed && !failed.ok) return { text: failed.error, bad: true };
  return { text: "Not checked yet", bad: false };
}

function feedNames(devices: Device[]) {
  const map = new Map<string, { device: string; feed: string }>();
  for (const device of devices) {
    for (const feed of device.feeds) map.set(feed.id, { device: device.name, feed: feed.label });
  }
  return map;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function parseSteps(text: string): GuideStep[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const split = line.split("|");
      if (split.length > 1) {
        return { title: split[0].trim(), detail: split.slice(1).join("|").trim() };
      }
      return { title: `Step ${index + 1}`, detail: line };
    });
}

function parseRepo(input: string): { owner: string; repo: string; url: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const urlMatch = trimmed.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  const match = urlMatch ?? shortMatch;
  if (!match) return null;
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };
}

function draftToDevice(draft: Draft): Device | string {
  const name = draft.name.trim();
  if (!name) return "Name the device.";
  const repo = parseRepo(draft.github);
  if (!repo) return "Use a GitHub repo like owner/name.";
  const install = parseSteps(draft.install);
  if (!install.length) return "Add at least one install step.";
  const recovery = parseSteps(draft.recovery);
  const id = draft.id || `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const docs = draft.docs.trim();
  if (docs && !docs.startsWith("https://")) return "Docs URL must start with https://";
  const companion =
    draft.companionTitle.trim() && draft.companionHref.trim()
      ? {
          title: draft.companionTitle.trim(),
          href: draft.companionHref.trim(),
          detail: draft.companionDetail.trim() || "Official emulator or live UI.",
        }
      : null;
  if (companion && !companion.href.startsWith("https://")) return "Emulator URL must start with https://";
  const device: Device = {
    id,
    name,
    blurb: draft.blurb.trim() || "Custom device",
    github: repo.url,
    links: docs ? [{ label: "Docs", href: docs }] : [],
    companion,
    feeds: [
      {
        id: `${id}-feed`,
        label: draft.channel === "prerelease" ? "Prerelease" : "Stable",
        watchDefault: true,
        spec: {
          kind: "github-release",
          owner: repo.owner,
          repo: repo.repo,
          channel: draft.channel,
          assetIncludes: draft.assetIncludes.trim() || undefined,
        },
      },
    ],
    install,
    recoveryTitle: recovery.length ? "Recovery if a flash goes wrong" : null,
    recovery: recovery.length ? recovery : null,
  };
  return device;
}

async function toggleNotify(
  notify: boolean,
  setNotify: (value: boolean) => void,
  setPerm: (value: NotificationPermission | "unknown") => void,
) {
  if (!notify) {
    setNotify(true);
    return;
  }
  if (typeof Notification === "undefined") {
    setNotify(false);
    return;
  }
  if (Notification.permission === "granted") {
    setNotify(false);
    return;
  }
  const next = await Notification.requestPermission();
  setPerm(next);
  setNotify(next === "granted");
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "boolean");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

const README = `# PenWare

Backup catalog for the PenWare firmware watch.

## Add hardware

1. Copy a device object into \`catalog.json\` under \`devices\`.
2. Commit it on \`main\`.
3. In PenWare, open Backup, paste:

\`https://raw.githubusercontent.com/<you>/PenWare/main/catalog.json\`

4. Pull catalog.

Private repositories cannot be pulled by the app. Make this repo public, or download the file and use Import.

\`penware-backup.json\` from the app also stores which versions you already marked installed. Keep that file off a public repo.

Built-in devices (Biscuit, Marauder v8, Pineapple Pager, Flipper, Banshee, HackRF Pro, FREE-WILi 2, T-Embed, Phantom) ship inside PenWare. This file is for hardware you add later.
`;
