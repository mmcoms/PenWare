import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Device, FeedHit } from "./types.ts";

type PenwareState = {
  hydrated: boolean;
  setHydrated: () => void;
  customDevices: Device[];
  hiddenIds: string[];
  watch: Record<string, boolean>;
  baseline: Record<string, string>;
  notified: Record<string, string>;
  results: Record<string, FeedHit>;
  catalogUrl: string;
  lastScanAt: number | null;
  notify: boolean;
  upsertCustom: (device: Device) => void;
  removeCustom: (id: string) => void;
  hideBuiltin: (id: string) => void;
  restoreHidden: () => void;
  setWatch: (feedId: string, value: boolean) => void;
  setCatalogUrl: (url: string) => void;
  setNotify: (value: boolean) => void;
  applyScan: (hits: FeedHit[], baselineUpdates: Record<string, string>, notifiedUpdates: Record<string, string>) => void;
  markInstalled: (feedId: string, version: string) => void;
  flagNeeded: (feedId: string) => void;
  mergeCustom: (devices: Device[]) => void;
  replaceCustom: (devices: Device[]) => void;
  importBackup: (payload: {
    customDevices: Device[];
    hiddenIds: string[];
    watch: Record<string, boolean>;
    baseline: Record<string, string>;
    notified: Record<string, string>;
    notify: boolean;
    catalogUrl: string;
  }) => void;
};

export const usePenware = create<PenwareState>()(
  persist(
    (set) => ({
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      customDevices: [],
      hiddenIds: [],
      watch: {},
      baseline: {},
      notified: {},
      results: {},
      catalogUrl: "",
      lastScanAt: null,
      notify: true,
      upsertCustom: (device) =>
        set((state) => {
          const rest = state.customDevices.filter((item) => item.id !== device.id);
          return { customDevices: [device, ...rest] };
        }),
      removeCustom: (id) =>
        set((state) => ({ customDevices: state.customDevices.filter((item) => item.id !== id) })),
      hideBuiltin: (id) =>
        set((state) => ({
          hiddenIds: state.hiddenIds.includes(id) ? state.hiddenIds : [...state.hiddenIds, id],
        })),
      restoreHidden: () => set({ hiddenIds: [] }),
      setWatch: (feedId, value) => set((state) => ({ watch: { ...state.watch, [feedId]: value } })),
      setCatalogUrl: (url) => set({ catalogUrl: url }),
      setNotify: (value) => set({ notify: value }),
      applyScan: (hits, baselineUpdates, notifiedUpdates) =>
        set((state) => {
          const results = { ...state.results };
          for (const hit of hits) results[hit.id] = hit;
          return {
            results,
            baseline: { ...state.baseline, ...baselineUpdates },
            notified: { ...state.notified, ...notifiedUpdates },
            lastScanAt: Date.now(),
          };
        }),
      markInstalled: (feedId, version) =>
        set((state) => ({
          baseline: { ...state.baseline, [feedId]: version },
          notified: { ...state.notified, [feedId]: version },
        })),
      flagNeeded: (feedId) =>
        set((state) => ({ baseline: { ...state.baseline, [feedId]: "" } })),
      mergeCustom: (devices) =>
        set((state) => {
          const map = new Map(state.customDevices.map((device) => [device.id, device]));
          for (const device of devices) map.set(device.id, device);
          return { customDevices: [...map.values()] };
        }),
      replaceCustom: (devices) => set({ customDevices: devices }),
      importBackup: (payload) =>
        set({
          customDevices: payload.customDevices,
          hiddenIds: payload.hiddenIds,
          watch: payload.watch,
          baseline: payload.baseline,
          notified: payload.notified,
          notify: payload.notify,
          catalogUrl: payload.catalogUrl,
        }),
    }),
    {
      name: "penware-v1",
      partialize: (state) => ({
        customDevices: state.customDevices,
        hiddenIds: state.hiddenIds,
        watch: state.watch,
        baseline: state.baseline,
        notified: state.notified,
        results: state.results,
        catalogUrl: state.catalogUrl,
        lastScanAt: state.lastScanAt,
        notify: state.notify,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);

export function feedWatched(watch: Record<string, boolean>, feedId: string, watchDefault: boolean) {
  const override = watch[feedId];
  return override === undefined ? watchDefault : override;
}
