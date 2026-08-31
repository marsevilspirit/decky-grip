import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import type { GuideLibraryEntry } from "../backend";

export interface RecentGuideSeed {
  identity: GuideIdentity;
  updatedAt: number;
}

interface PersistedRecentGuide extends RecentGuideSeed {}

function copyIdentity(identity: GuideIdentity): GuideIdentity {
  makeGuideKey(identity);
  return { ...identity };
}

/**
 * Keeps the latest guide independently for every app. Persisted bookmarks seed
 * the index, while guides observed during this plugin lifetime always take
 * precedence for their app and for the global fallback.
 */
export class RecentGuideIndex {
  private readonly persistedByApp = new Map<string, PersistedRecentGuide>();
  private readonly observedByApp = new Map<string, GuideIdentity>();
  private latestPersisted: PersistedRecentGuide | null = null;
  private latestObserved: GuideIdentity | null = null;

  seed(entries: Iterable<RecentGuideSeed>): void {
    this.persistedByApp.clear();
    this.latestPersisted = null;
    for (const entry of entries) {
      const identity = copyIdentity(entry.identity);
      if (!Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) {
        throw new TypeError(
          "recent guide timestamp must be a non-negative integer",
        );
      }
      const candidate = { identity, updatedAt: entry.updatedAt };
      const current = this.persistedByApp.get(identity.appId);
      if (!current || candidate.updatedAt >= current.updatedAt) {
        this.persistedByApp.set(identity.appId, candidate);
      }
      if (
        !this.latestPersisted ||
        candidate.updatedAt >= this.latestPersisted.updatedAt
      ) {
        this.latestPersisted = candidate;
      }
    }
  }

  remember(identity: GuideIdentity): void {
    const remembered = copyIdentity(identity);
    this.observedByApp.set(remembered.appId, remembered);
    this.latestObserved = remembered;
  }

  find(preferredAppId?: string): GuideIdentity | null {
    const identity =
      preferredAppId === undefined
        ? (this.latestObserved ?? this.latestPersisted?.identity ?? null)
        : (this.observedByApp.get(preferredAppId) ??
          this.persistedByApp.get(preferredAppId)?.identity ??
          null);
    return identity ? { ...identity } : null;
  }
}

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

export function filterGuideLibraryEntries(
  entries: readonly GuideLibraryEntry[],
  query: string,
  favoritesOnly: boolean,
): GuideLibraryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (favoritesOnly && !entry.favorite) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return [
      entry.appId,
      entry.guideId,
      entry.cache?.title,
      entry.cache?.author,
      entry.cache?.sectionTitle,
    ].some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}
