import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Device, FeedHit, FeedSpec } from "./types.ts";

const feedSchema = z.object({
  id: z.string().min(1).max(80),
  spec: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("github-release"),
      owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      channel: z.enum(["stable", "prerelease"]),
      assetIncludes: z.string().max(80).optional(),
    }),
    z.object({
      kind: z.literal("biscuit"),
      product: z.enum(["Biscuit_V1", "Biscuit_Ultra"]),
      channel: z.enum(["Prod", "Beta"]),
    }),
    z.object({
      kind: z.literal("hak5"),
      model: z.literal("wifipineapplepager"),
    }),
  ]),
});

const stepSchema = z.object({
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(800),
});

const deviceSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  blurb: z.string().max(240),
  github: z.string().url().max(200),
  links: z
    .array(z.object({ label: z.string().min(1).max(60), href: z.string().url().max(300) }))
    .max(8),
  companion: z
    .object({
      title: z.string().min(1).max(80),
      href: z.string().url().max(300),
      detail: z.string().min(1).max(500),
    })
    .nullable(),
  feeds: z.array(feedSchema.extend({ label: z.string().min(1).max(40), watchDefault: z.boolean() })).min(1).max(8),
  install: z.array(stepSchema).min(1).max(10),
  recoveryTitle: z.string().max(80).nullable(),
  recovery: z.array(stepSchema).max(8).nullable(),
});

type GithubRelease = {
  tag_name?: string;
  name?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  assets?: { name?: string; browser_download_url?: string }[];
  message?: string;
};

const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const TEN_MINUTES = 10 * 60 * 1000;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TEN_MINUTES) return hit.data as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = load()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      inflight.delete(key);
      return data;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise as Promise<T>;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "PenWare",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error("Rate limit. Try again in a few minutes.");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function plain(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function miss(id: string, error: string): FeedHit {
  return { id, ok: false, error };
}

async function githubRelease(owner: string, repo: string, channel: "stable" | "prerelease") {
  const key = `gh:${owner}/${repo}:${channel}`;
  return cached(key, async () => {
    if (channel === "stable") {
      const body = (await fetchJson(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      )) as GithubRelease;
      if (!body.tag_name) throw new Error(body.message || "No stable release");
      return body;
    }
    const body = (await fetchJson(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
    )) as GithubRelease[] | GithubRelease;
    if (!Array.isArray(body)) throw new Error(body.message || "No releases");
    const found = body.find((release) => release.prerelease && !release.draft && release.tag_name);
    if (!found) throw new Error("No prerelease");
    return found;
  });
}

function fromGithub(id: string, release: GithubRelease, assetIncludes?: string): FeedHit {
  const assets = release.assets ?? [];
  const match = assetIncludes
    ? assets.find((asset) => asset.name?.toLowerCase().includes(assetIncludes.toLowerCase()))
    : undefined;
  const names = assetIncludes
    ? assets
        .map((asset) => asset.name ?? "")
        .filter((name) => name.toLowerCase().includes(assetIncludes.toLowerCase()))
    : [];
  const noteParts = [
    match ? names.slice(0, 3).join(", ") : "",
    !match && assetIncludes ? `No file matching ${assetIncludes}` : "",
    plain(release.body),
  ].filter(Boolean);
  return {
    id,
    ok: true,
    version: release.tag_name ?? "unknown",
    publishedAt: release.published_at ?? null,
    url: release.html_url ?? `https://github.com`,
    fileUrl: match?.browser_download_url ?? null,
    fileName: match?.name ?? null,
    note: noteParts.join(" · ").slice(0, 280),
  };
}

async function checkOne(id: string, spec: FeedSpec): Promise<FeedHit> {
  try {
    if (spec.kind === "github-release") {
      const release = await githubRelease(spec.owner, spec.repo, spec.channel);
      return fromGithub(id, release, spec.assetIncludes);
    }
    if (spec.kind === "biscuit") {
      const key = `biscuit:${spec.product}:${spec.channel}`;
      const manifest = await cached(key, () =>
        fetchJson(
          `https://firmware.biscuitshop.us/${spec.product}/${spec.channel}/manifest.json`,
        ),
      );
      const body = manifest as {
        c5?: { version?: string };
        wroom?: { version?: string };
        notes?: string;
      };
      const c5 = body.c5?.version;
      const wroom = body.wroom?.version;
      if (!c5) return miss(id, "Manifest has no C5 version");
      return {
        id,
        ok: true,
        version: wroom ? `C5 ${c5} · WROOM ${wroom}` : `C5 ${c5}`,
        publishedAt: null,
        url: `https://firmware.biscuitshop.us/${spec.product}/${spec.channel}/manifest.json`,
        fileUrl: null,
        fileName: null,
        note: plain(typeof body.notes === "string" ? body.notes : ""),
      };
    }
    const key = "hak5:pager";
    const list = await cached(key, () =>
      fetchJson("https://downloads.hak5.org/api/devices/wifipineapplepager/firmwares"),
    );
    if (!Array.isArray(list) || list.length === 0) return miss(id, "Portal returned no firmware");
    const row = list[0] as {
      version?: string;
      release_date?: string;
      checksum?: string;
      changelog?: string;
    };
    if (!row.version) return miss(id, "Portal row has no version");
    return {
      id,
      ok: true,
      version: row.version,
      publishedAt: row.release_date ?? null,
      url: "https://downloads.hak5.org/pineapple/pager",
      fileUrl: null,
      fileName: null,
      note: [row.checksum ? `SHA-256 ${row.checksum}` : "", plain(row.changelog)]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 280),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Check failed";
    return miss(id, message);
  }
}

export const checkFeeds = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.array(feedSchema).max(40).parse(data))
  .handler(async ({ data }) => {
    const results = await Promise.all(data.map((feed) => checkOne(feed.id, feed.spec)));
    return { results };
  });

const catalogUrlSchema = z
  .string()
  .url()
  .max(300)
  .refine(
    (value) => /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.+\.json$/.test(value),
    "Use a raw.githubusercontent.com link to a .json file",
  );

export const pullCatalog = createServerFn({ method: "POST" })
  .validator((data: unknown) => catalogUrlSchema.parse(data))
  .handler(async ({ data: url }) => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "PenWare" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { devices?: unknown };
    const list = Array.isArray(body) ? body : body.devices;
    if (!Array.isArray(list)) throw new Error("JSON needs a devices array");
    const devices: Device[] = [];
    for (const item of list.slice(0, 40)) {
      const parsed = deviceSchema.safeParse(item);
      if (parsed.success) devices.push(parsed.data);
    }
    if (devices.length === 0) throw new Error("No valid devices in that file");
    return { devices };
  });
