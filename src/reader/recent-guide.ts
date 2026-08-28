import type { PositionSnapshots } from "../backend";
import { splitGuideKey, type GuideIdentity } from "../steam/guide-key";

export function chooseObservedGuide(
  activeGuide: GuideIdentity | null,
  lastGuide: GuideIdentity | null,
  runningAppId?: string,
): GuideIdentity | null {
  const candidates = [activeGuide, lastGuide];
  return (
    candidates.find(
      (identity): identity is GuideIdentity =>
        identity !== null &&
        (runningAppId === undefined || identity.appId === runningAppId),
    ) ?? null
  );
}

export function findMostRecentGuide(
  positions: PositionSnapshots,
  preferredAppId?: string,
): GuideIdentity | null {
  const entries = Object.entries(positions)
    .map(([guideKey, position]) => ({
      identity: splitGuideKey(guideKey),
      updatedAt: position.updatedAt,
    }))
    .filter(
      ({ identity }) =>
        preferredAppId === undefined || identity.appId === preferredAppId,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return entries[0]?.identity ?? null;
}
