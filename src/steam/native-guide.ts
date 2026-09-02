import {
  getGamepadNavigationTrees,
  getReactInstance,
  Router,
  SideMenu,
} from "@decky/ui";
import type { Provider } from "react";

import type { GuideIdentity } from "./guide-key";
import { normalizeGuideId, parseGuideRoute } from "./guide-route";
import { findGuideActionBar, findGuideScroller } from "./guide-scroll";

export interface NativeGuideLocation {
  pathname: string;
  search?: string;
  hash?: string;
  key?: string;
  state?: unknown;
}

export interface NativeGuideView {
  readonly document: Document;
  readonly identity: GuideIdentity;
  readonly location: NativeGuideLocation;
  readonly numericAppId: number;
  replaceLocationState(state: Record<string, unknown>): boolean;
}

export interface NativeGuideActionTarget {
  readonly element: HTMLElement;
  readonly navigationNode: unknown;
  readonly navigationProvider: Provider<unknown>;
}

interface NavigationFiber {
  readonly tag?: number;
  readonly memoizedProps?: { node?: unknown; value?: unknown };
  readonly return?: NavigationFiber | null;
  readonly type?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readDocument(navigationTrees: unknown): Document | null {
  if (!Array.isArray(navigationTrees)) {
    return null;
  }

  const tree = navigationTrees.find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      (candidate.m_ID ?? candidate.id) === "MainNavMenuContainer",
  );
  if (!isRecord(tree)) {
    return null;
  }

  const modernRoot = isRecord(tree.Root) ? tree.Root.Element : undefined;
  const legacyRoot = isRecord(tree.m_Root) ? tree.m_Root.m_element : undefined;
  const root = modernRoot ?? legacyRoot;
  if (!isRecord(root) || !isRecord(root.ownerDocument)) {
    return null;
  }

  return root.ownerDocument as unknown as Document;
}

function readAppId(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const appId = value.appid;
  return typeof appId === "number" && Number.isSafeInteger(appId) && appId > 0
    ? appId
    : null;
}

function readLocation(value: unknown): NativeGuideLocation | null {
  return isRecord(value) && typeof value.pathname === "string"
    ? (value as unknown as NativeGuideLocation)
    : null;
}

export function resolveNativeGuideView(
  mainWindow: unknown,
  navigationTrees: unknown,
): NativeGuideView | null {
  try {
    if (!isRecord(mainWindow) || !isRecord(mainWindow.MenuStore)) {
      return null;
    }
    const menuStore = mainWindow.MenuStore;
    const guideStore = menuStore.MainMenuStore;
    if (
      typeof menuStore.GetOpenSideMenu !== "function" ||
      menuStore.GetOpenSideMenu() !== SideMenu.Main ||
      !isRecord(guideStore) ||
      typeof guideStore.GetFocusedApp !== "function" ||
      typeof guideStore.GetAppControlsLastLocation !== "function" ||
      typeof guideStore.GetSelectedGuide !== "function"
    ) {
      return null;
    }

    const numericAppId = readAppId(guideStore.GetFocusedApp());
    if (numericAppId === null) {
      return null;
    }
    const location = readLocation(
      guideStore.GetAppControlsLastLocation(numericAppId),
    );
    const route = location && parseGuideRoute(location.pathname);
    if (!location || !route || route.numericAppId !== numericAppId) {
      return null;
    }
    const guideId = normalizeGuideId(guideStore.GetSelectedGuide(numericAppId));
    const document = readDocument(navigationTrees);
    if (!guideId || !document?.defaultView) {
      return null;
    }

    return {
      document,
      identity: { appId: route.appId, guideId },
      location,
      numericAppId,
      replaceLocationState(state) {
        if (typeof guideStore.SetAppControlsLastLocation !== "function") {
          return false;
        }
        guideStore.SetAppControlsLastLocation(numericAppId, {
          ...location,
          state,
        });
        return true;
      },
    };
  } catch {
    return null;
  }
}

export function readNativeGuideView(
  mainWindow: unknown = Router.WindowStore?.GamepadUIMainWindowInstance,
): NativeGuideView | null {
  try {
    return resolveNativeGuideView(mainWindow, getGamepadNavigationTrees());
  } catch {
    return null;
  }
}

function isNavigationNode(value: unknown): value is {
  m_rgChildren: unknown[];
} {
  return isRecord(value) && Array.isArray(value.m_rgChildren);
}

function readNavigationTarget(
  element: HTMLElement,
): Omit<NativeGuideActionTarget, "element"> | null {
  let fiber = getReactInstance(element) as NavigationFiber | undefined;
  let navigationNode: unknown = null;

  for (let depth = 0; fiber && depth < 40; depth += 1) {
    const props = fiber.memoizedProps;
    if (!navigationNode && isNavigationNode(props?.node)) {
      navigationNode = props.node;
    }
    if (
      navigationNode &&
      props?.value === navigationNode &&
      fiber.tag === 10 &&
      (typeof fiber.type === "object" || typeof fiber.type === "function") &&
      fiber.type !== null
    ) {
      return {
        navigationNode,
        navigationProvider: fiber.type as Provider<unknown>,
      };
    }
    fiber = fiber.return ?? undefined;
  }

  return null;
}

export function resolveNativeGuideActionTarget(
  view: NativeGuideView,
): NativeGuideActionTarget | null {
  const scroller = findGuideScroller(view.document);
  const element = scroller && findGuideActionBar(scroller.element);
  if (!element) {
    return null;
  }
  const navigation = readNavigationTarget(element);
  return navigation ? { element, ...navigation } : null;
}

export function findNativeGuideActionTarget(
  expectedIdentity: GuideIdentity,
): NativeGuideActionTarget | null {
  try {
    const view = readNativeGuideView();
    if (
      !view ||
      view.identity.appId !== expectedIdentity.appId ||
      view.identity.guideId !== expectedIdentity.guideId
    ) {
      return null;
    }
    return resolveNativeGuideActionTarget(view);
  } catch {
    return null;
  }
}
