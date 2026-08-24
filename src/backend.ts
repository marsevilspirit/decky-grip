import { callable } from "@decky/api";

export interface StoredPosition {
  scroll_top: number;
  updated_at_ms: number;
}

export const getPosition = callable<[guideKey: string], StoredPosition | null>(
  "get_position",
);

export const savePosition = callable<
  [guideKey: string, scrollTop: number],
  StoredPosition
>("save_position");

export const deletePosition = callable<[guideKey: string], boolean>(
  "delete_position",
);

export const clearPositions = callable<[], number>("clear_positions");

export const getPositionCount = callable<[], number>("get_position_count");
