#!/usr/bin/env node
/**
 * Pure tests for the release asset picker. No network.
 * Run: node scripts/watch.test.mjs   (also wired to `npm test`)
 *
 * These reproduce the exact releases that exposed the first-match bug:
 *   - HackRF (Mayhem hpro): plain SD zip + "-no-world-map" zip + OCI flasher tar
 *   - Banshee (GhostESP):   Banshee_C5.zip + Banshee_S3.zip, both required
 *   - Marauder/Phantom:     one _v8.bin / one guition .bin among many boards
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAssets } from "./watch.mjs";

const asset = (name) => ({ name, browser_download_url: `https://dl/${name}` });

test("HackRF hpro: picks the full SD build, not -no-world-map, not the OCI tar", () => {
  const assets = [
    // Intentionally list the no-map build FIRST — that is the order that used
    // to win under the old .find() code.
    asset("COPY_TO_SDCARD_hpro_mayhem_v2.4.0-no-world-map.zip"),
    asset("OCI_hpro_mayhem_v2.4.0.ppfw.tar"),
    asset("COPY_TO_SDCARD_hpro_mayhem_v2.4.0.zip"),
    asset("COPY_TO_SDCARD_h4m_mayhem_v2.4.0.zip"), // wrong board, must not match
  ];
  const { files } = pickAssets(assets, {
    assetIncludes: "COPY_TO_SDCARD_hpro",
    assetExcludes: ["no-world-map"],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "COPY_TO_SDCARD_hpro_mayhem_v2.4.0.zip");
});

test("HackRF hpro: ranking alone demotes -no-world-map even without an exclude", () => {
  const assets = [
    asset("COPY_TO_SDCARD_hpro_mayhem_v2.4.0-no-world-map.zip"),
    asset("COPY_TO_SDCARD_hpro_mayhem_v2.4.0.zip"),
  ];
  const { files } = pickAssets(assets, { assetIncludes: "COPY_TO_SDCARD_hpro" });
  assert.equal(files[0].name, "COPY_TO_SDCARD_hpro_mayhem_v2.4.0.zip");
});

test("Banshee: multiAsset keeps BOTH chip files", () => {
  const assets = [
    asset("Banshee_C5.zip"),
    asset("Banshee_S3.zip"),
    asset("Cardputer_v2.2.2.zip"), // unrelated, must not match
  ];
  const { files } = pickAssets(assets, { assetIncludes: "Banshee_", multiAsset: true });
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ["Banshee_C5.zip", "Banshee_S3.zip"]);
});

test("Banshee WITHOUT multiAsset would drop a chip (guards the regression)", () => {
  const assets = [asset("Banshee_C5.zip"), asset("Banshee_S3.zip")];
  const { files } = pickAssets(assets, { assetIncludes: "Banshee_" });
  assert.equal(files.length, 1); // single-asset mode = only one file; why Banshee needs multiAsset
});

test("Marauder v8: picks the _v8.bin among many board bins", () => {
  const assets = [
    asset("esp32_marauder_v1_20_0_20261028_flipper.bin"),
    asset("esp32_marauder_v1_20_0_20261028_v8.bin"),
    asset("esp32_marauder_v1_20_0_20261028_v6.bin"),
  ];
  const { files } = pickAssets(assets, { assetIncludes: "_v8.bin" });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "esp32_marauder_v1_20_0_20261028_v8.bin");
});

test("Phantom: picks the guition bin, not the 2432S028 panel", () => {
  const assets = [
    asset("esp32_marauder_v1_20_0_20261028_cyd_2432S028.bin"),
    asset("esp32_marauder_v1_20_0_20261028_cyd_2432S024_guition.bin"),
  ];
  const { files } = pickAssets(assets, { assetIncludes: "_cyd_2432S024_guition.bin" });
  assert.equal(files[0].name, "esp32_marauder_v1_20_0_20261028_cyd_2432S024_guition.bin");
});

test("checksum/sidecar files are demoted below the real firmware", () => {
  const assets = [
    asset("FREE-WILi2-v10.zip.sha256"),
    asset("FREE-WILi2-v10.zip"),
  ];
  const { files } = pickAssets(assets, { assetIncludes: "FREE-WILi2-v10.zip" });
  assert.equal(files[0].name, "FREE-WILi2-v10.zip");
});

test("no match: empty files and a usable matchedNames list", () => {
  const assets = [asset("something_else.zip")];
  const { files, matchedNames } = pickAssets(assets, { assetIncludes: "hpro" });
  assert.equal(files.length, 0);
  assert.equal(matchedNames.length, 0);
});

test("no assetIncludes: nothing is picked", () => {
  const { files } = pickAssets([asset("whatever.zip")], {});
  assert.equal(files.length, 0);
});
