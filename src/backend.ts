import { callable } from "@decky/api";

import type { DownloadedGuide, ReaderPosition } from "./reader/types";

export interface StoredPosition {
  scroll_top: number;
  updated_at_ms: number;
}

export interface PositionSnapshot {
  scrollTop: number;
  updatedAt: number;
}

export type PositionSnapshots = Record<string, PositionSnapshot>;

export interface HotkeyStatus {
  available: boolean;
  button: "L4";
  device: string | null;
  running: boolean;
}

export interface GuideImagePayload {
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  base64: string;
  fromCache: boolean;
  width: number;
  height: number;
}

export interface CacheClearResult {
  filesRemoved: number;
  bytesRemoved: number;
}

export interface ReaderCacheStats {
  guides: {
    files: number;
    bytes: number;
  };
  images: {
    files: number;
    diskBytes: number;
    diskLimitBytes: number;
    memoryEntries: number;
    memoryBytes: number;
    memoryLimitBytes: number;
  };
}

export interface PositionStoreRepairResult {
  repaired: boolean;
  backup: string | null;
}

export interface PositionStoresRepairResult {
  positions: PositionStoreRepairResult;
  readerPositions: PositionStoreRepairResult;
}

export const getPositions = callable<[], PositionSnapshots>("get_positions");

export const savePosition = callable<
  [guideKey: string, scrollTop: number],
  StoredPosition
>("save_position");

export const getHotkeyStatus = callable<[], HotkeyStatus>("get_hotkey_status");

export const getGuide = callable<
  [guideId: string, forceRefresh?: boolean],
  DownloadedGuide
>("get_guide");

export const getCachedGuide = callable<
  [guideId: string],
  DownloadedGuide | null
>("get_cached_guide");

export const getGuideImage = callable<
  [url: string, allowDownload?: boolean],
  GuideImagePayload | null
>("get_guide_image");

export const clearGuideCache = callable<[], CacheClearResult>(
  "clear_guide_cache",
);

export const clearImageCache = callable<[], CacheClearResult>(
  "clear_image_cache",
);

export const getReaderCacheStats = callable<[], ReaderCacheStats>(
  "get_reader_cache_stats",
);

export const repairPositionStores = callable<[], PositionStoresRepairResult>(
  "repair_position_stores",
);

export const getReaderPosition = callable<
  [guideKey: string],
  ReaderPosition | null
>("get_reader_position");

export const saveReaderPosition = callable<
  [
    guideKey: string,
    scrollTop: number,
    sectionId: string | null,
    anchorText: string | null,
    anchorOffset: number,
  ],
  ReaderPosition
>("save_reader_position");
