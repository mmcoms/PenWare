#!/usr/bin/env node
/**
 * PenWare background watcher.
 *
 * Runs on a schedule in GitHub Actions (.github/workflows/watch.yml):
 *   1. Reads catalog.json and checks every feed with watchDefault: true.
 *   2. Compares each version with status.json (the last known versions).
 *   3. Writes the new status.json and, if anything changed, alert.md
 *      (the workflow turns alert.md into a GitHub issue, which emails you).
 *
 * The first run only records a baseline. No alert is raised for it.
 * Uses the same official sources as the app (src/lib/penware/check.ts).
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const CATALOG = "catalog.json";
const STATUS = "status.json";
const ALERT = "alert.md";

function plain(value) {
  if (!value) return "";
  return String(value)
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

export function makeChecker(fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const cache = new Map();

  async function getJson(url, github = false) {
    if (cache.has(url)) return cache.get(url);
    const headers = { Accept: "application/json", "User-Agent": "PenWare-watch" };
    if (github) {
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const promise = (async () => {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })();
    cache.set(url, promise);
    return promise;
  }

  async function githubRelease(owner, repo, channel) {
    if (channel === "stable") {
      const body = await getJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, true);
      if (!body?.tag_name) throw new Error("No stable release");
      return body;
    }
    const list = await getJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`, true);
    if (!Array.isArray(list)) throw new Error("No releases");
    const found = list.find((r) => r.prerelease && !r.draft && r.tag_name);
    if (!found) throw new Error("No prerelease");
    return found;
  }

  return async function checkOne(spec) {
    if (spec.kind === "github-release") {
      const release = await githubRelease(spec.owner, spec.repo, spec.channel);
      const needle = spec.assetIncludes?.toLowerCase();
      const asset = needle
        ? (release.assets ?? []).find((a) => a.name?.toLowerCase().includes(needle))
        : undefined;
      return {
        version: release.tag_name,
        publishedAt: release.published_at ?? null,
        url: release.html_url ?? null,
        fileUrl: asset?.browser_download_url ?? null,
        fileName: asset?.name ?? null,
        note: plain(release.body),
      };
    }
    if (spec.kind === "biscuit") {
      const url = `https://firmware.biscuitshop.us/${spec.product}/${spec.channel}/manifest.json`;
      const body = await getJson(url);
      const c5 = body?.c5?.version;
      const wroom = body?.wroom?.version;
      if (!c5) throw new Error("Manifest has no C5 version");
      return {
        version: wroom ? `C5 ${c5} · WROOM ${wroom}` : `C5 ${c5}`,
        publishedAt: null,
        url,
        fileUrl: null,
        fileName: null,
        note: plain(typeof body.notes === "string" ? body.notes : ""),
      };
    }
    if (spec.kind === "hak5") {
      const list = await getJson("https://downloads.hak5.org/api/devices/wifipineapplepager/firmwares");
      const row = Array.isArray(list) ? list[0] : null;
      if (!row?.version) throw new Error("Portal returned no firmware");
      return {
        version: row.version,
        publishedAt: row.release_date ?? null,
        url: "https://downloads.hak5.org/pineapple/pager",
        fileUrl: null,
        fileName: null,
        note: [row.checksum ? `SHA-256 ${row.checksum}` : "", plain(row.changelog)].filter(Boolean).join(" · "),
      };
    }
    throw new Error(`Unknown feed kind ${spec.kind}`);
  };
}

/** Pure comparison step, kept separate so it can be tested without the network. */
export function compare(previous, results) {
  const firstRun = !previous;
  const changes = [];
  const feeds = {};
  for (const r of results) {
    const old = previous?.feeds?.[r.id];
    if (!r.ok) {
      // Keep the last good version so a temporary outage never looks like a change.
      if (old) feeds[r.id] = old;
      continue;
    }
    feeds[r.id] = { device: r.device, label: r.label, ...r.hit };
    if (!firstRun && old?.version && old.version !== r.hit.version) {
      changes.push({ id: r.id, device: r.device, label: r.label, from: old.version, ...r.hit });
    }
  }
  return { firstRun, changes, feeds };
}

export function renderAlert(changes) {
  const title =
    changes.length === 1
      ? `New firmware: ${changes[0].device} ${changes[0].label} → ${changes[0].version}`
      : `New firmware: ${changes.length} updates (${[...new Set(changes.map((c) => c.device))].join(", ")})`;
  const lines = [
    "PenWare's background check found new firmware on these watched channels:",
    "",
    "| Device | Channel | Was | Now |",
    "|---|---|---|---|",
    ...changes.map(
      (c) => `| ${c.device} | ${c.label} | ${c.from} | [${c.version}](${c.url ?? "https://penware.app"}) |`,
    ),
    "",
  ];
  for (const c of changes) {
    lines.push(`### ${c.device} · ${c.label} · ${c.version}`);
    if (c.fileName && c.fileUrl) lines.push(`File: [${c.fileName}](${c.fileUrl})`);
    if (c.note) lines.push(`> ${c.note}`);
    lines.push("");
  }
  lines.push("Open https://penware.app for install and recovery steps. Close this issue once you've updated.");
  return { title, body: lines.join("\n") };
}

async function main() {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  const previous = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, "utf8")) : null;
  const checkOne = makeChecker();

  const watched = catalog.devices.flatMap((d) =>
    d.feeds.filter((f) => f.watchDefault).map((f) => ({ id: f.id, device: d.name, label: f.label, spec: f.spec })),
  );

  const results = await Promise.all(
    watched.map(async (w) => {
      try {
        return { ...w, ok: true, hit: await checkOne(w.spec) };
      } catch (error) {
        return { ...w, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const { firstRun, changes, feeds } = compare(previous, results);
  const failed = results.filter((r) => !r.ok);
  // No timestamps in the file: it only changes (and gets committed) when a version changes.
  writeFileSync(STATUS, JSON.stringify({ feeds }, null, 2) + "\n");

  rmSync(ALERT, { force: true });
  if (changes.length) {
    const { title, body } = renderAlert(changes);
    writeFileSync(ALERT, `${title}\n${body}\n`);
  }

  console.log(
    `${firstRun ? "Baseline recorded" : "Checked"}: ${results.length} feeds, ` +
      `${changes.length} new, ${failed.length} failed`,
  );
  for (const f of failed) console.log(`  ! ${f.device} ${f.label}: ${f.error}`);
  for (const c of changes) console.log(`  + ${c.device} ${c.label}: ${c.from} → ${c.version}`);
  // Fail the run only if every source failed (a real outage or a broken script).
  if (failed.length === results.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
