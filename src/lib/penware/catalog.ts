import type { Device } from "./types.ts";
import catalog from "../../../catalog.json";

/**
 * The built-in device list comes straight from catalog.json in the repo root.
 * That one file is shared by the app, the background firmware watch
 * (scripts/watch.mjs) and the device backup panel, so a device added there
 * shows up everywhere. See "Adding a device" in README.md.
 */
export const BUILTIN_DEVICES: Device[] = (catalog as unknown as { devices: Device[] }).devices;
