import {
  Button,
  Focusable,
  GamepadButton,
  Spinner,
  useParams,
  type GamepadEvent,
} from "@decky/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  captureReaderPosition,
  ReaderAnchorIndex,
  restoreReaderPosition,
} from "../reader/anchor";
import {
  ReaderImageHydrator,
  type GuideImageFetcher,
} from "../reader/image-hydrator";
import type { ReaderImageCacheControl } from "../reader/image-cache-control";
import type { ReaderPerformanceTracker } from "../reader/performance";
import {
  initialRenderedSectionCount,
  nextRenderedSectionCount,
} from "../reader/progressive-render";
import {
  ReaderSessionCache,
  retainGuideForStaleRefresh,
  type ReaderSessionSnapshot,
} from "../reader/session-cache";
import { shortSectionTitle } from "../reader/toc-title";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

const SAVE_DELAY_MS = 400;
const RESTORE_STABLE_MS = 100;
const RESTORE_TIMEOUT_MS = 10_000;
const LOADING_INDICATOR_DELAY_MS = 180;
const MAX_OBSERVED_GUIDE_IMAGES = 512;

const READER_CSS = `
.grip-reader-content { color: #dcdedf; font-size: 18px; line-height: 1.55; padding: 10px 34px 80px; }
.grip-reader-content img { display: block; max-width: 100%; height: auto; margin: 14px auto; border-radius: 4px; }
.grip-reader-content img[data-grip-image-url]:not([src]) { background: #17212b; min-height: 48px; opacity: 0.55; }
.grip-reader-content img[data-grip-image-state="unavailable"] { border: 1px dashed #6b747d; }
.grip-reader-content .grip-reader-section { margin: 0 auto 34px; max-width: 920px; }
.grip-reader-content .grip-reader-section-title { color: #67c1f5; font-size: 27px; margin: 24px 0 14px; }
.grip-reader-content .bb_h1, .grip-reader-content .bb_h2, .grip-reader-content .bb_h3 { color: #f3f3f3; font-weight: 700; margin: 20px 0 8px; }
.grip-reader-content .bb_h1 { font-size: 25px; }
.grip-reader-content .bb_h2 { font-size: 22px; }
.grip-reader-content .bb_h3 { font-size: 20px; }
.grip-reader-content .bb_code { background: #18232e; border-left: 4px solid #417a9b; margin: 10px 0; padding: 10px 14px; }
.grip-reader-content .bb_table { border-collapse: collapse; display: table; margin: 12px 0; width: 100%; }
.grip-reader-content .bb_table_tr { display: table-row; }
.grip-reader-content .bb_table_td, .grip-reader-content .bb_table_th { border: 1px solid #3d4c5b; display: table-cell; padding: 8px; }
.grip-reader-content .bb_table_th { background: #223241; font-weight: 700; }
.grip-reader-content .bb_link { color: #67c1f5; text-decoration: underline; }
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readIdentity(
  appId: string | undefined,
  guideId: string | undefined,
): GuideIdentity | null {
  if (!appId || !guideId) {
    return null;
  }
  const identity = { appId, guideId };
  try {
    makeGuideKey(identity);
    return identity;
  } catch {
    return null;
  }
}

export interface GuideReaderPageProps {
  cache: ReaderSessionCache;
  fetchImage: GuideImageFetcher;
  imageCacheControl: ReaderImageCacheControl;
  onClose: () => void;
  onRepairPositions: () => Promise<string>;
  performance: ReaderPerformanceTracker;
}

interface SectionRenderState {
  guide: ReaderSessionSnapshot["guide"] | null;
  count: number;
}

export function GuideReaderPage({
  cache,
  fetchImage,
  imageCacheControl,
  onClose,
  onRepairPositions,
  performance,
}: GuideReaderPageProps) {
  const params = useParams<{ appId?: string; guideId?: string }>();
  const identity = readIdentity(params.appId, params.guideId);
  const initialSnapshot = identity ? cache.peek(identity) : null;
  const [loaded, setLoaded] = useState<ReaderSessionSnapshot | null>(
    initialSnapshot,
  );
  const [loading, setLoading] = useState(initialSnapshot === null);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restoreWarning, setRestoreWarning] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshPending, setRefreshPending] = useState(false);
  const [positionRepairBusy, setPositionRepairBusy] = useState(false);
  const [sectionRenderState, setSectionRenderState] =
    useState<SectionRenderState>(() => ({
      guide: initialSnapshot?.guide ?? null,
      count: initialRenderedSectionCount(
        initialSnapshot?.guide.sections.length ?? 0,
      ),
    }));
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const anchorIndexRef = useRef<ReaderAnchorIndex | null>(null);
  const anchorGuideRef = useRef<ReaderSessionSnapshot["guide"] | null>(null);
  const pendingSectionJumpRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [imageHydrator] = useState(() => new ReaderImageHydrator(fetchImage));
  const imageCachePausedRef = useRef(imageCacheControl.getSnapshot().paused);
  const imageObserverRef = useRef<IntersectionObserver | null>(null);
  const observedImageSectionsRef = useRef<WeakSet<Element>>(new WeakSet());
  const observedImageCountRef = useRef(0);
  const nearImagesRef = useRef<Set<HTMLImageElement>>(new Set());
  const pendingObservedImagesRef = useRef<Set<HTMLImageElement>>(new Set());
  const imageViewportChangeRef = useRef<() => void>(() => undefined);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const cancelReader = (event: CustomEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const restoringRef = useRef(false);
  const stopRestoreRef = useRef<(() => void) | null>(null);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestQueuedSaveRef = useRef<{
    signature: string;
    promise: Promise<boolean>;
    token: object;
  } | null>(null);
  const pendingSaveCountRef = useRef(0);

  useLayoutEffect(() => {
    if (identity) {
      performance.markRouteMounted(identity);
    }
  }, [identity?.appId, identity?.guideId, performance]);

  const hydrateNearImages = useCallback(() => {
    const connected = [...nearImagesRef.current].filter(
      (image) => image.isConnected,
    );
    nearImagesRef.current = new Set(connected);
    imageHydrator.setPinnedImages(connected);
    if (!imageCachePausedRef.current) {
      imageHydrator.hydrateImages(connected);
    }
  }, [imageHydrator]);

  useEffect(() => {
    const synchronize = () => {
      const paused = imageCacheControl.getSnapshot().paused;
      imageCachePausedRef.current = paused;
      if (paused) {
        imageHydrator.clear();
      } else {
        requestAnimationFrame(hydrateNearImages);
      }
    };
    const unsubscribe = imageCacheControl.subscribe(synchronize);
    imageCacheControl.resume();
    synchronize();
    return () => {
      unsubscribe();
      imageObserverRef.current?.disconnect();
      imageHydrator.clear();
    };
  }, [hydrateNearImages, imageCacheControl, imageHydrator]);

  useEffect(() => {
    imageCacheControl.resume();
  }, [identity?.appId, identity?.guideId, imageCacheControl]);

  useEffect(() => {
    if (!loading || loaded) {
      setShowLoadingIndicator(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowLoadingIndicator(true);
      if (identity) {
        performance.markSpinner(identity);
      }
    }, LOADING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [identity?.appId, identity?.guideId, loaded, loading, performance]);

  useEffect(() => {
    if (!identity) {
      setLoaded(null);
      setLoading(false);
      return;
    }

    let canceled = false;
    const cached = cache.peek(identity);
    const held =
      loadedRef.current?.guide.guideId === identity.guideId
        ? loadedRef.current
        : null;
    const fallback = cached ?? held;
    setLoaded(fallback);
    setLoading(fallback === null);
    setError(null);
    setLoadWarning(null);
    setSaveError(null);
    setRestoreWarning(null);
    cache
      .load(identity, { forceRefresh: refreshGeneration > 0 })
      .then((snapshot) => {
        if (!canceled) {
          const displaySnapshot = retainGuideForStaleRefresh(
            loadedRef.current,
            snapshot,
            refreshGeneration > 0,
          );
          const { position } = displaySnapshot;
          lastSavedSignatureRef.current =
            position && position.updatedAt > 0
              ? JSON.stringify({
                  scrollTop: position.scrollTop,
                  sectionId: position.sectionId,
                  anchorText: position.anchorText,
                  anchorOffset: position.anchorOffset,
                })
              : null;
          setLoaded(displaySnapshot);
          if (refreshGeneration > 0 && snapshot.guide.stale) {
            setLoadWarning("更新失败，继续使用本地缓存。");
          }
          performance.markCacheReady(
            identity,
            cached ? "memory" : snapshot.guide.fromCache ? "disk" : "network",
          );
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) {
          const heldFallback =
            loadedRef.current?.guide.guideId === identity.guideId
              ? loadedRef.current
              : null;
          const fallback = cache.peek(identity) ?? heldFallback;
          if (fallback === null) {
            setError(errorMessage(reason));
            performance.failIdentity(
              identity,
              `指南正文加载失败：${errorMessage(reason)}`,
            );
          } else {
            setLoaded(fallback);
            setLoadWarning(
              `更新失败，继续使用本地缓存：${errorMessage(reason)}`,
            );
          }
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
          setRefreshPending(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [
    cache,
    identity?.appId,
    identity?.guideId,
    performance,
    refreshGeneration,
  ]);

  const renderedSectionCount = loaded
    ? sectionRenderState.guide === loaded.guide
      ? sectionRenderState.count
      : initialRenderedSectionCount(loaded.guide.sections.length)
    : 0;

  useEffect(() => {
    const guide = loaded?.guide ?? null;
    const total = guide?.sections.length ?? 0;
    let scheduledCount = initialRenderedSectionCount(total);
    setSectionRenderState({ guide, count: scheduledCount });
    if (!guide || scheduledCount >= total) {
      return;
    }

    let canceled = false;
    let animationFrame = 0;
    const appendBatch = () => {
      if (canceled) {
        return;
      }
      scheduledCount = nextRenderedSectionCount(scheduledCount, total);
      setSectionRenderState((current) => ({
        guide,
        count:
          current.guide === guide
            ? Math.max(current.count, scheduledCount)
            : scheduledCount,
      }));
      if (scheduledCount < total) {
        animationFrame = requestAnimationFrame(appendBatch);
      }
    };
    animationFrame = requestAnimationFrame(appendBatch);
    return () => {
      canceled = true;
      cancelAnimationFrame(animationFrame);
    };
  }, [loaded?.guide]);

  useLayoutEffect(() => {
    const guide = loaded?.guide ?? null;
    const content = contentRef.current;
    if (!guide || !content) {
      anchorGuideRef.current = null;
      anchorIndexRef.current = null;
      return;
    }
    if (
      anchorGuideRef.current !== guide ||
      anchorIndexRef.current?.content !== content
    ) {
      anchorGuideRef.current = guide;
      anchorIndexRef.current = new ReaderAnchorIndex(content);
    } else {
      anchorIndexRef.current.refresh();
    }
  }, [loaded?.guide, renderedSectionCount]);

  useLayoutEffect(() => {
    const guide = loaded?.guide ?? null;
    const content = contentRef.current;
    const scroller = scrollerRef.current;
    imageObserverRef.current?.disconnect();
    imageObserverRef.current = null;
    observedImageSectionsRef.current = new WeakSet();
    observedImageCountRef.current = 0;
    nearImagesRef.current.clear();
    pendingObservedImagesRef.current.clear();
    imageHydrator.clear();
    if (!guide || !content || !scroller) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const image = entry.target as HTMLImageElement;
          pendingObservedImagesRef.current.delete(image);
          if (entry.isIntersecting && image.isConnected) {
            nearImagesRef.current.add(image);
          } else {
            nearImagesRef.current.delete(image);
          }
        }
        hydrateNearImages();
        imageViewportChangeRef.current();
      },
      { root: scroller, rootMargin: "150% 0px 150% 0px" },
    );
    imageObserverRef.current = observer;
    return () => {
      observer.disconnect();
      if (imageObserverRef.current === observer) {
        imageObserverRef.current = null;
      }
      observedImageSectionsRef.current = new WeakSet();
      observedImageCountRef.current = 0;
      nearImagesRef.current.clear();
      pendingObservedImagesRef.current.clear();
      imageHydrator.clear();
    };
  }, [hydrateNearImages, imageHydrator, loaded?.guide]);

  useLayoutEffect(() => {
    const guide = loaded?.guide ?? null;
    const content = contentRef.current;
    if (!guide || !content) {
      return;
    }
    const observer = imageObserverRef.current;
    const sections = content.querySelectorAll<Element>(
      "[data-guide-section-id]",
    );
    const newlyMountedImages: HTMLImageElement[] = [];
    for (const section of sections) {
      if (observedImageSectionsRef.current.has(section)) {
        continue;
      }
      observedImageSectionsRef.current.add(section);
      const remaining =
        MAX_OBSERVED_GUIDE_IMAGES - observedImageCountRef.current;
      if (remaining <= 0) {
        break;
      }
      const images = [
        ...section.querySelectorAll<HTMLImageElement>(
          "img[data-grip-image-url]",
        ),
      ].slice(0, remaining);
      observedImageCountRef.current += images.length;
      newlyMountedImages.push(...images);
    }

    if (!observer) {
      for (const image of newlyMountedImages) {
        nearImagesRef.current.add(image);
      }
      hydrateNearImages();
      return;
    }
    for (const image of newlyMountedImages) {
      pendingObservedImagesRef.current.add(image);
      observer.observe(image);
    }
  }, [hydrateNearImages, loaded?.guide, renderedSectionCount]);

  useLayoutEffect(() => {
    if (!identity || !loaded) {
      return;
    }
    const animationFrame = requestAnimationFrame(() =>
      performance.markContentFirstFrame(identity),
    );
    return () => cancelAnimationFrame(animationFrame);
  }, [identity?.appId, identity?.guideId, loaded?.guide, performance]);

  const persistPosition = useCallback(async (): Promise<boolean> => {
    if (!identity || !scrollerRef.current || !contentRef.current) {
      return true;
    }
    const captured = captureReaderPosition(
      scrollerRef.current,
      contentRef.current,
      anchorIndexRef.current ?? undefined,
    );
    const signature = JSON.stringify(captured);
    if (latestQueuedSaveRef.current?.signature === signature) {
      return latestQueuedSaveRef.current.promise;
    }
    if (
      pendingSaveCountRef.current === 0 &&
      signature === lastSavedSignatureRef.current
    ) {
      return true;
    }
    const token = {};
    pendingSaveCountRef.current += 1;
    const operation = saveChainRef.current
      .then(async () => {
        try {
          await cache.savePosition(identity, captured);
          lastSavedSignatureRef.current = signature;
          setSaveError(null);
          return true;
        } catch (reason: unknown) {
          setSaveError(errorMessage(reason));
          return false;
        }
      })
      .finally(() => {
        pendingSaveCountRef.current -= 1;
        if (latestQueuedSaveRef.current?.token === token) {
          latestQueuedSaveRef.current = null;
        }
      });
    saveChainRef.current = operation.then(() => undefined);
    latestQueuedSaveRef.current = { signature, promise: operation, token };
    return operation;
  }, [cache, identity?.appId, identity?.guideId]);

  const cancelRestore = useCallback(() => {
    stopRestoreRef.current?.();
    stopRestoreRef.current = null;
    restoringRef.current = false;
  }, []);

  const failAndCancelRestore = useCallback(
    (reason: string) => {
      if (restoringRef.current && identity) {
        performance.failIdentity(identity, reason);
      }
      cancelRestore();
    },
    [cancelRestore, identity?.appId, identity?.guideId, performance],
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    const position = loaded?.position;
    if (!scroller || !content) {
      restoringRef.current = false;
      return;
    }
    if (!position) {
      restoringRef.current = false;
      if (identity) {
        performance.markPositionSettled(
          identity,
          loaded?.positionWarning ? "unavailable" : "skipped",
        );
      }
      try {
        scroller.focus({ preventScroll: true });
      } catch {
        scroller.focus();
      }
      return;
    }

    cancelRestore();
    restoringRef.current = true;
    let stopped = false;
    let cleaned = false;
    let performanceTimedOut = false;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let animationFrame = 0;
    let lastAppliedScrollTop: number | null = null;
    const clearStableTimer = () => {
      if (stableTimer !== null) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
    };
    const positionIsReady = () => {
      const index = anchorIndexRef.current;
      const anchorReady =
        !position.anchorText ||
        (index?.candidates(position.anchorText, position.sectionId).length ??
          0) > 0;
      const allSectionsRendered =
        content.querySelectorAll("[data-guide-section-id]").length >=
        (loaded?.guide.sections.length ?? 0);
      const maxScrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const target = Math.min(position.scrollTop, maxScrollTop);
      const pixelFallbackReady =
        allSectionsRendered && Math.abs(scroller.scrollTop - target) <= 1;
      return position.anchorText
        ? anchorReady || pixelFallbackReady
        : pixelFallbackReady;
    };
    const visibleImagesAreReady = () => {
      if (pendingObservedImagesRef.current.size > 0) {
        return false;
      }
      const images = [...nearImagesRef.current].filter(
        (image) => image.isConnected,
      );
      return images.every((image) => {
        const state = image.dataset.gripImageState;
        return (
          state === "unavailable" ||
          state === "deferred" ||
          (state === "ready" && image.complete)
        );
      });
    };
    const applyRestore = () => {
      anchorIndexRef.current?.refresh();
      const restored = restoreReaderPosition(
        scroller,
        content,
        position,
        anchorIndexRef.current ?? undefined,
      );
      hydrateNearImages();
      return restored;
    };
    const stop = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      stopped = true;
      cancelAnimationFrame(animationFrame);
      clearStableTimer();
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      observer.disconnect();
      content.removeEventListener("load", onLayoutChange, true);
      content.removeEventListener("error", onImageError, true);
      if (imageViewportChangeRef.current === finishIfStable) {
        imageViewportChangeRef.current = () => undefined;
      }
    };
    const finishIfStable = () => {
      if (stopped) {
        return;
      }
      const restored = applyRestore();
      const moved =
        lastAppliedScrollTop !== null &&
        Math.abs(restored - lastAppliedScrollTop) > 1;
      lastAppliedScrollTop = restored;
      if (!positionIsReady() || !visibleImagesAreReady()) {
        clearStableTimer();
        return;
      }
      if (moved) {
        clearStableTimer();
      }
      if (stableTimer === null) {
        stableTimer = setTimeout(() => {
          stableTimer = null;
          if (stopped) {
            return;
          }
          const confirmed = applyRestore();
          const shifted =
            lastAppliedScrollTop !== null &&
            Math.abs(confirmed - lastAppliedScrollTop) > 1;
          lastAppliedScrollTop = confirmed;
          if (shifted || !positionIsReady() || !visibleImagesAreReady()) {
            finishIfStable();
            return;
          }
          if (!performanceTimedOut && identity) {
            performance.markPositionSettled(identity, "restored");
          }
          setRestoreWarning(null);
          stop();
          restoringRef.current = false;
          if (stopRestoreRef.current === stop) {
            stopRestoreRef.current = null;
          }
        }, RESTORE_STABLE_MS);
      }
    };
    imageViewportChangeRef.current = finishIfStable;
    function onLayoutChange() {
      finishIfStable();
    }
    function onImageError(event: Event) {
      const image = event.target as HTMLImageElement | null;
      if (image?.dataset.gripImageUrl) {
        image.dataset.gripImageState = "unavailable";
      }
      finishIfStable();
    }
    const observer = new ResizeObserver(onLayoutChange);
    observer.observe(content);
    content.addEventListener("load", onLayoutChange, true);
    content.addEventListener("error", onImageError, true);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = requestAnimationFrame(finishIfStable);
    });
    timeoutTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      performanceTimedOut = true;
      if (identity) {
        performance.markPositionSettled(identity, "unavailable");
      }
      setRestoreWarning(
        "阅读位置在 10 秒内未稳定；正文已显示，GRIP 会继续尝试恢复。",
      );
      finishIfStable();
    }, RESTORE_TIMEOUT_MS);
    stopRestoreRef.current = stop;

    const interactionEvents = [
      "wheel",
      "touchmove",
      "pointerdown",
      "keydown",
      "vgp_onbuttondown",
      "vgp_ondirection",
    ];
    const onInteraction = () =>
      failAndCancelRestore("用户在阅读位置稳定前开始操作");
    for (const event of interactionEvents) {
      scroller.addEventListener(event, onInteraction, true);
    }
    try {
      scroller.focus({ preventScroll: true });
    } catch {
      scroller.focus();
    }

    return () => {
      stop();
      if (stopRestoreRef.current === stop) {
        stopRestoreRef.current = null;
      }
      for (const event of interactionEvents) {
        scroller.removeEventListener(event, onInteraction, true);
      }
    };
  }, [
    cancelRestore,
    failAndCancelRestore,
    hydrateNearImages,
    identity?.appId,
    identity?.guideId,
    loaded,
    performance,
  ]);

  useLayoutEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!restoringRef.current) {
        void persistPosition();
      } else if (identity) {
        performance.failIdentity(identity, "页面在阅读位置稳定前关闭");
      }
      cancelRestore();
    },
    [
      cancelRestore,
      identity?.appId,
      identity?.guideId,
      performance,
      persistPosition,
    ],
  );

  const onScroll = () => {
    if (restoringRef.current || loading || refreshPending) {
      return;
    }
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistPosition();
    }, SAVE_DELAY_MS);
  };

  const scrollReaderBy = (amount: number, event: GamepadEvent) => {
    const scroller = scrollerRef.current;
    if (!scroller || loading || refreshPending) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    const nextScrollTop = Math.max(
      0,
      Math.min(scroller.scrollTop + amount, maxScrollTop),
    );
    if (nextScrollTop === scroller.scrollTop) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    failAndCancelRestore("用户在阅读位置稳定前翻页");
    scroller.scrollTop = nextScrollTop;
    onScroll();
  };

  const onReaderDirection = (event: GamepadEvent) => {
    const line = Math.max(96, (scrollerRef.current?.clientHeight ?? 0) * 0.16);
    if (event.detail.button === GamepadButton.DIR_UP) {
      scrollReaderBy(-line, event);
    } else if (event.detail.button === GamepadButton.DIR_DOWN) {
      scrollReaderBy(line, event);
    }
  };

  const onReaderButton = (event: GamepadEvent) => {
    const page = Math.max(320, (scrollerRef.current?.clientHeight ?? 0) * 0.78);
    if (
      event.detail.button === GamepadButton.BUMPER_LEFT ||
      event.detail.button === GamepadButton.TRIGGER_LEFT
    ) {
      scrollReaderBy(-page, event);
    } else if (
      event.detail.button === GamepadButton.BUMPER_RIGHT ||
      event.detail.button === GamepadButton.TRIGGER_RIGHT
    ) {
      scrollReaderBy(page, event);
    }
  };

  const refreshGuide = async () => {
    if (refreshPending || loading) {
      return;
    }
    imageCacheControl.resume();
    setRefreshPending(true);
    if (!restoringRef.current) {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const saved = await persistPosition();
      if (!saved) {
        setRefreshPending(false);
        return;
      }
    }
    setRefreshGeneration((generation) => generation + 1);
  };

  const retryReaderPosition = async (repair: boolean) => {
    if (!identity || positionRepairBusy) {
      return;
    }
    setPositionRepairBusy(true);
    try {
      const repairMessage = repair ? await onRepairPositions() : null;
      const snapshot = await cache.retryPosition(identity);
      setLoaded(snapshot);
      setLoadWarning(snapshot.positionWarning ? null : repairMessage);
    } catch (reason: unknown) {
      setLoadWarning(`阅读位置恢复失败，正文仍可使用：${errorMessage(reason)}`);
    } finally {
      setPositionRepairBusy(false);
    }
  };

  const scrollToRenderedSection = (sectionId: string): boolean => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) {
      return false;
    }
    const index = anchorIndexRef.current;
    index?.refresh();
    const section = index?.sectionElement(sectionId) ?? null;
    if (section) {
      const scrollerRect = scroller.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      scroller.scrollTop += sectionRect.top - scrollerRect.top;
      scroller.focus({ preventScroll: true });
      onScroll();
      return true;
    }
    return false;
  };

  const jumpToSection = (sectionId: string) => {
    failAndCancelRestore("用户在阅读位置稳定前跳转章节");
    if (scrollToRenderedSection(sectionId)) {
      return;
    }
    const guide = loaded?.guide;
    const sectionIndex = guide?.sections.findIndex(
      (section) => section.id === sectionId,
    );
    if (!guide || sectionIndex === undefined || sectionIndex < 0) {
      return;
    }
    pendingSectionJumpRef.current = sectionId;
    setSectionRenderState((current) => ({
      guide,
      count:
        current.guide === guide
          ? Math.max(current.count, sectionIndex + 1)
          : sectionIndex + 1,
    }));
  };

  useLayoutEffect(() => {
    const pendingSection = pendingSectionJumpRef.current;
    if (pendingSection && scrollToRenderedSection(pendingSection)) {
      pendingSectionJumpRef.current = null;
    }
  }, [renderedSectionCount]);

  if (!identity) {
    return (
      <div style={{ color: "white", padding: 48 }}>
        <h1>GRIP Reader</h1>
        <p>尚未选择指南。请从 Decky 打开 GRIP，然后选择“继续阅读”。</p>
        <Button onClick={onClose}>返回</Button>
      </div>
    );
  }

  const readerWarning =
    restoreWarning ?? loadWarning ?? loaded?.positionWarning ?? null;

  return (
    <Focusable
      onCancel={cancelReader}
      style={{
        background: "linear-gradient(180deg, #16202b 0%, #0d141c 100%)",
        color: "#dcdedf",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <style>{READER_CSS}</style>
      <div
        style={{
          alignItems: "center",
          borderBottom: "1px solid #314252",
          display: "flex",
          gap: 12,
          minHeight: 70,
          padding: "0 28px",
        }}
      >
        <Button onClick={onClose}>返回</Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {loaded?.guide.title ?? `Steam guide ${identity.guideId}`}
          </div>
          <div style={{ fontSize: 13, opacity: 0.65 }}>
            GRIP 独立阅读器 · 按正文锚点精确续读
            {loaded?.guide.stale ? " · 本地缓存版本，可按更新获取新版" : ""}
          </div>
        </div>
      </div>

      {readerWarning && (
        <div
          style={{
            alignItems: "center",
            background: "#5c471f",
            display: "flex",
            gap: 10,
            padding: "8px 28px",
          }}
        >
          <div style={{ flex: 1 }}>{readerWarning}</div>
          {loaded?.positionWarning && (
            <>
              <Button
                disabled={positionRepairBusy}
                onClick={() => void retryReaderPosition(false)}
              >
                重试位置
              </Button>
              <Button
                disabled={positionRepairBusy}
                onClick={() => void retryReaderPosition(true)}
              >
                备份并重置
              </Button>
            </>
          )}
        </div>
      )}

      {loading && !loaded ? (
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flex: 1,
            gap: 14,
            justifyContent: "center",
          }}
        >
          {showLoadingIndicator ? (
            <>
              <Spinner /> 正在下载并整理指南…
            </>
          ) : null}
        </div>
      ) : error ? (
        <div style={{ padding: 48 }}>
          <h2>无法打开该指南</h2>
          <p>{error}</p>
          <Button onClick={() => void refreshGuide()}>重试</Button>
        </div>
      ) : loaded ? (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Focusable
            aria-label="指南正文"
            ref={scrollerRef}
            flow-children="none"
            onButtonDown={onReaderButton}
            onGamepadDirection={onReaderDirection}
            onScroll={onScroll}
            preferredFocus
            style={{
              flex: 1,
              minWidth: 0,
              outline: "none",
              overflowY: loading || refreshPending ? "hidden" : "auto",
              scrollBehavior: "auto",
            }}
            role="region"
            tabIndex={0}
          >
            <div className="grip-reader-content" ref={contentRef}>
              {loaded.guide.sections
                .slice(0, renderedSectionCount)
                .map((section) => (
                  <section
                    className="grip-reader-section"
                    data-guide-section-id={section.id}
                    key={section.id}
                  >
                    <div className="grip-reader-section-title">
                      {section.title}
                    </div>
                    <div dangerouslySetInnerHTML={{ __html: section.html }} />
                  </section>
                ))}
            </div>
          </Focusable>
          <div
            aria-label="指南目录"
            className="grip-reader-toc"
            role="navigation"
            style={{
              background: "rgba(7, 12, 18, 0.48)",
              borderLeft: "1px solid #314252",
              boxSizing: "border-box",
              flex: "0 0 88px",
              overflowY: "auto",
              padding: "18px 6px",
            }}
          >
            <Button
              aria-label="更新指南"
              disabled={loading || refreshPending}
              onClick={() => void refreshGuide()}
              style={{
                boxSizing: "border-box",
                fontSize: 16,
                lineHeight: "22px",
                marginBottom: 16,
                minWidth: 0,
                overflow: "hidden",
                padding: "8px 2px",
                whiteSpace: "nowrap",
                width: "100%",
              }}
            >
              更新
            </Button>
            {loaded.guide.sections
              .slice(0, renderedSectionCount)
              .map((section) => (
                <Button
                  aria-label={`跳转到章节：${section.title}`}
                  disabled={loading || refreshPending}
                  key={section.id}
                  onClick={() => jumpToSection(section.id)}
                  style={{
                    boxSizing: "border-box",
                    fontSize: 16,
                    lineHeight: "22px",
                    marginBottom: 8,
                    minWidth: 0,
                    overflow: "hidden",
                    padding: "8px 2px",
                    whiteSpace: "nowrap",
                    width: "100%",
                  }}
                >
                  {shortSectionTitle(section.title)}
                </Button>
              ))}
          </div>
        </div>
      ) : null}

      {saveError && (
        <div
          style={{
            background: "#6d2525",
            bottom: 12,
            padding: "8px 14px",
            position: "absolute",
            right: 12,
          }}
        >
          阅读位置保存失败：{saveError}
        </div>
      )}
    </Focusable>
  );
}
