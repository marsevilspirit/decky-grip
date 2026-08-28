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

export const getPosition = callable<[guideKey: string], StoredPosition | null>(
  "get_position",
);

export const getPositions = callable<[], PositionSnapshots>("get_positions");

export const savePosition = callable<
  [guideKey: string, scrollTop: number],
  StoredPosition
>("save_position");

export const deletePosition = callable<[guideKey: string], boolean>(
  "delete_position",
);

export const clearPositions = callable<[], number>("clear_positions");

export const getPositionCount = callable<[], number>("get_position_count");

export const getHotkeyStatus = callable<[], HotkeyStatus>("get_hotkey_status");

export const getGuide = callable<
  [guideId: string, forceRefresh?: boolean],
  DownloadedGuide
>("get_guide");

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
