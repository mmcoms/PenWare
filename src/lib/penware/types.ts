export type GithubSpec = {
  kind: "github-release";
  owner: string;
  repo: string;
  channel: "stable" | "prerelease";
  assetIncludes?: string;
};

export type BiscuitSpec = {
  kind: "biscuit";
  /** Folder name on firmware.biscuitshop.us, e.g. "Biscuit_V1" (Pro), "Biscuit_Ultra", "Biscuit_Crumb". */
  product: string;
  channel: "Prod" | "Beta";
};

export type Hak5Spec = {
  kind: "hak5";
  model: "wifipineapplepager";
};

export type FeedSpec = GithubSpec | BiscuitSpec | Hak5Spec;

export type DeviceFeed = {
  id: string;
  label: string;
  watchDefault: boolean;
  spec: FeedSpec;
};

export type GuideStep = {
  title: string;
  detail: string;
};

export type LinkItem = {
  label: string;
  href: string;
};

export type Companion = {
  title: string;
  href: string;
  detail: string;
};

/** How PenWare helps you back up before updating. */
export type DeviceBackup =
  | {
      /** Full flash backup over USB (Web Serial + esptool-js). */
      kind: "esp32";
      /** Shown to the user, e.g. "ESP32-S3 + ESP32-C5". */
      chips: string;
      note?: string;
    }
  | {
      /** A short list of things to save by hand (SD card, app backup, loot). */
      kind: "checklist";
      items: string[];
    };

export type Device = {
  id: string;
  name: string;
  blurb: string;
  github: string;
  links: LinkItem[];
  companion: Companion | null;
  feeds: DeviceFeed[];
  install: GuideStep[];
  recoveryTitle: string | null;
  recovery: GuideStep[] | null;
  backup?: DeviceBackup;
};

export type FeedHit =
  | {
      id: string;
      ok: true;
      version: string;
      publishedAt: string | null;
      url: string;
      fileUrl: string | null;
      fileName: string | null;
      note: string;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export type BackupFile = {
  penware: 1;
  exportedAt: string;
  catalogUrl: string;
  customDevices: Device[];
  hiddenIds: string[];
  watch: Record<string, boolean>;
  baseline: Record<string, string>;
  notified: Record<string, string>;
  notify: boolean;
};

export function isDevice(value: unknown): value is Device {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<Device>;
  if (typeof d.id !== "string" || !d.id || d.id.length > 80) return false;
  if (typeof d.name !== "string" || !d.name) return false;
  if (typeof d.blurb !== "string") return false;
  if (typeof d.github !== "string" || !d.github.startsWith("https://")) return false;
  if (!Array.isArray(d.feeds) || d.feeds.length === 0 || d.feeds.length > 12) return false;
  if (!Array.isArray(d.install) || d.install.length === 0) return false;
  if (!Array.isArray(d.links)) return false;
  if (d.companion !== null && typeof d.companion !== "object") return false;
  if (d.recovery !== null && !Array.isArray(d.recovery)) return false;
  return d.feeds.every((feed) => {
    if (!feed || typeof feed !== "object") return false;
    if (typeof feed.id !== "string" || typeof feed.label !== "string") return false;
    if (typeof feed.watchDefault !== "boolean") return false;
    const spec = feed.spec;
    if (!spec || typeof spec !== "object" || !("kind" in spec)) return false;
    if (spec.kind === "github-release") {
      return typeof spec.owner === "string" && typeof spec.repo === "string";
    }
    if (spec.kind === "biscuit") {
      return typeof spec.product === "string" && /^Biscuit_[A-Za-z0-9]+$/.test(spec.product);
    }
    return spec.kind === "hak5" && spec.model === "wifipineapplepager";
  });
}
