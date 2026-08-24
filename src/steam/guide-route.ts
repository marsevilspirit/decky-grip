import type { GuideIdentity } from "./guide-key";

const GUIDE_ROUTE = /^\/app\/([1-9]\d{0,19})\/overlay\/guides\/?$/;
const GUIDE_ID = /^[1-9]\d{0,19}$/;

export interface GuideRoute {
  appId: string;
  numericAppId: number;
}

export interface SelectedGuideStore {
  GetSelectedGuide(appId: number): unknown;
}

export function parseGuideRoute(pathname: string): GuideRoute | null {
  const match = GUIDE_ROUTE.exec(pathname);
  if (!match) {
    return null;
  }

  const numericAppId = Number(match[1]);
  if (!Number.isSafeInteger(numericAppId) || numericAppId <= 0) {
    return null;
  }

  return { appId: match[1], numericAppId };
}

export function normalizeGuideId(value: unknown): string | null {
  return typeof value === "string" && GUIDE_ID.test(value) ? value : null;
}

export function readActiveGuide(
  pathname: string,
  store: SelectedGuideStore,
): GuideIdentity | null {
  const route = parseGuideRoute(pathname);
  if (!route) {
    return null;
  }

  try {
    const guideId = normalizeGuideId(
      store.GetSelectedGuide(route.numericAppId),
    );
    return guideId === null ? null : { appId: route.appId, guideId };
  } catch {
    return null;
  }
}
