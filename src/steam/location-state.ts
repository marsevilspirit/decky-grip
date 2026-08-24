const GUIDE_SCROLL_TOP_KEY =
  /^OverlayGuide_([1-9]\d{0,19})ScrollTop_HistoryValue$/;
const DECIMAL_GUIDE_ID = /^[1-9]\d{0,19}$/;

export const MAX_SCROLL_TOP = 1_000_000_000;

export interface GuideScrollSnapshot {
  guideId: string;
  scrollTop: number;
}

export type MergeGuideScrollResult =
  | { changed: false; state: Record<string, unknown> }
  | { changed: true; state: Record<string, unknown> };

function readStateRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function isScrollTop(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SCROLL_TOP
  );
}

export function guideScrollTopKey(guideId: string): string {
  if (!DECIMAL_GUIDE_ID.test(guideId)) {
    throw new TypeError(
      "guideId must be a positive decimal string of at most 20 digits",
    );
  }

  return `OverlayGuide_${guideId}ScrollTop_HistoryValue`;
}

/** Read all verified keys for diagnostics, not to identify the active guide. */
export function extractGuideScrollSnapshots(
  locationState: unknown,
): GuideScrollSnapshot[] {
  const state = readStateRecord(locationState);
  if (state === null) {
    return [];
  }
  const snapshots: GuideScrollSnapshot[] = [];

  try {
    for (const [key, value] of Object.entries(state)) {
      const match = GUIDE_SCROLL_TOP_KEY.exec(key);
      if (match && isScrollTop(value)) {
        snapshots.push({ guideId: match[1], scrollTop: value });
      }
    }
  } catch {
    return [];
  }

  return snapshots;
}

export function readGuideScrollSnapshot(
  locationState: unknown,
  expectedGuideId: string,
): GuideScrollSnapshot | null {
  const state = readStateRecord(locationState);
  if (state === null) {
    return null;
  }

  const key = guideScrollTopKey(expectedGuideId);
  try {
    const value = state[key];
    return isScrollTop(value)
      ? { guideId: expectedGuideId, scrollTop: value }
      : null;
  } catch {
    return null;
  }
}

export function mergeGuideScrollSnapshot(
  locationState: unknown,
  snapshot: GuideScrollSnapshot,
): MergeGuideScrollResult {
  if (!isScrollTop(snapshot.scrollTop)) {
    throw new TypeError(`scrollTop must be between 0 and ${MAX_SCROLL_TOP}`);
  }

  const state = readStateRecord(locationState);
  if (state === null) {
    throw new TypeError("locationState must be an object, null, or undefined");
  }
  const key = guideScrollTopKey(snapshot.guideId);

  try {
    if (state[key] === snapshot.scrollTop) {
      return { changed: false, state };
    }

    return {
      changed: true,
      state: {
        ...state,
        [key]: snapshot.scrollTop,
      },
    };
  } catch {
    throw new TypeError("locationState could not be safely copied");
  }
}
