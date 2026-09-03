import {
  Button,
  Focusable,
  GamepadButton,
  Spinner,
  TextField,
  useParams,
  type GamepadEvent,
} from "@decky/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { GuideLibraryEntry } from "../backend";
import {
  captureReaderPosition,
  ReaderAnchorIndex,
  restoreReaderPosition,
} from "../reader/anchor";
import {
  isReaderScrollInteraction,
  ReaderCheckpoint,
  readerRestoreCanSettle,
} from "../reader/checkpoint";
import {
  ReaderImageHydrator,
  type GuideImageFetcher,
} from "../reader/image-hydrator";
import type { ReaderImageCacheControl } from "../reader/image-cache-control";
import type { ReaderPerformanceTracker } from "../reader/performance";
import {
  ReaderSessionCache,
  retainGuideForStaleRefresh,
  type ReaderSessionSnapshot,
} from "../reader/session-cache";
import { guideChoicesForReader } from "../reader/recent-guide";
import {
  buildGuideSearchIndex,
  locateGuideSearchRange,
  searchGuideIndex,
  type GuideSearchIndex,
  type GuideSearchResult,
} from "../reader/search";
import { shortSectionTitle } from "../reader/toc-title";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import { BusyLabel } from "./BusyLabel";

const SAVE_DELAY_MS = 400;
const STEAM_TOP_BAR_HEIGHT = 40;
const RESTORE_STABLE_MS = 100;
const RESTORE_TIMEOUT_MS = 10_000;
const LOADING_INDICATOR_DELAY_MS = 180;
const MAX_OBSERVED_GUIDE_IMAGES = 512;
const SECTION_RENDER_BATCH = 8;
const SEARCH_HIGHLIGHT_MS = 1_800;
const SEARCH_ALIGNMENT_TIMEOUT_MS = RESTORE_TIMEOUT_MS;
const SEARCH_SCROLL_MARGIN = 48;
const READER_CSS = `
@keyframes grip-guide-switcher-enter { from { opacity: 0; transform: translateY(-10px); } }
@keyframes grip-guide-content-enter { from { opacity: 0.35; transform: translateX(12px); } }
@media (prefers-reduced-motion: no-preference) {
  .grip-reader-guide-switcher { animation: grip-guide-switcher-enter 140ms ease-out; }
  .grip-reader-guide-enter { animation: grip-guide-content-enter 180ms ease-out; }
}
.grip-reader-content { color: #dcdedf; font-size: 18px; line-height: 1.55; padding: 10px 34px 80px; }
.grip-reader-content ::selection { background: #f3c64b; color: #101820; }
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
.grip-reader-content .bb_table, .grip-reader-content table { border-collapse: collapse; display: table; margin: 12px 0; table-layout: fixed; width: 100%; }
.grip-reader-content .bb_table_tr, .grip-reader-content tr { display: table-row; }
.grip-reader-content .bb_table_td, .grip-reader-content .bb_table_th, .grip-reader-content td, .grip-reader-content th { border: 1px solid #3d4c5b; display: table-cell; overflow-wrap: anywhere; padding: 8px; vertical-align: top; white-space: normal; }
.grip-reader-content .bb_table_th, .grip-reader-content th { background: #223241; font-weight: 700; }
.grip-reader-content .bb_link { color: #67c1f5; text-decoration: underline; }
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function GuideSectionBody({ html }: { html: string }) {
  // React 19 replaces innerHTML when this object changes, detaching hydrated images.
  const markup = useMemo(() => ({ __html: html }), [html]);
  return <div data-guide-search-body dangerouslySetInnerHTML={markup} />;
}

function focusWithoutScrolling(element: HTMLElement | null | undefined): void {
  if (!element) {
    return;
  }
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function selectionMatchesRange(selection: Selection, range: Range): boolean {
  if (selection.rangeCount !== 1) {
    return false;
  }
  const selected = selection.getRangeAt(0);
  return (
    selected.startContainer === range.startContainer &&
    selected.startOffset === range.startOffset &&
    selected.endContainer === range.endContainer &&
    selected.endOffset === range.endOffset
  );
}

function guideChoiceDetails(entry: GuideLibraryEntry): string {
  return [
    entry.cache
      ? entry.cache.stale
        ? "旧正文已缓存，可更新"
        : "正文已缓存"
      : "首次打开将下载正文",
    entry.cache?.author ? `作者：${entry.cache.author}` : null,
    entry.cache?.sectionTitle ? `上次：${entry.cache.sectionTitle}` : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join(" · ");
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
  loadGuideLibrary: (appId: string) => Promise<GuideLibraryEntry[]>;
  onClose: () => void;
  onRepairPositions: () => Promise<string>;
  onSwitchGuide: (identity: GuideIdentity) => Promise<void>;
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
  loadGuideLibrary,
  onClose,
  onRepairPositions,
  onSwitchGuide,
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
  const [saveRetryPending, setSaveRetryPending] = useState(false);
  const [restoreWarning, setRestoreWarning] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshPending, setRefreshPending] = useState(false);
  const [positionRepairMode, setPositionRepairMode] = useState<
    "retry" | "repair" | null
  >(null);
  const [guideSwitcherOpen, setGuideSwitcherOpen] = useState(false);
  const [guideLibrary, setGuideLibrary] = useState<GuideLibraryEntry[] | null>(
    null,
  );
  const [guideSwitcherError, setGuideSwitcherError] = useState<string | null>(
    null,
  );
  const [guideSwitcherRevision, setGuideSwitcherRevision] = useState(0);
  const [switchPending, setSwitchPending] = useState<string | null>(null);
  const [guideSearchOpen, setGuideSearchOpen] = useState(false);
  const [guideSearchQuery, setGuideSearchQuery] = useState("");
  const [activeGuideSearchResultIndex, setActiveGuideSearchResultIndex] =
    useState<number | null>(null);
  const [sectionRenderState, setSectionRenderState] =
    useState<SectionRenderState>(() => ({
      guide: initialSnapshot?.guide ?? null,
      count: Math.min(initialSnapshot?.guide.sections.length ?? 0, 1),
    }));
  const positionRepairBusy = positionRepairMode !== null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const guideSwitcherCloseRef = useRef<HTMLDivElement | null>(null);
  const guideSearchButtonRef = useRef<HTMLDivElement | null>(null);
  const guideSearchIndexRef = useRef<{
    guide: ReaderSessionSnapshot["guide"];
    index: GuideSearchIndex;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const anchorIndexRef = useRef<ReaderAnchorIndex | null>(null);
  const anchorGuideRef = useRef<ReaderSessionSnapshot["guide"] | null>(null);
  const pendingSectionJumpRef = useRef<string | null>(null);
  const pendingGuideSearchJumpRef = useRef<GuideSearchResult | null>(null);
  const guideSearchHighlightRangeRef = useRef<Range | null>(null);
  const guideSearchHighlightTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const guideSearchAlignmentStopRef = useRef<(() => void) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [imageHydrator] = useState(() => new ReaderImageHydrator(fetchImage));
  const [checkpoint] = useState(() => new ReaderCheckpoint());
  const imageCachePausedRef = useRef(imageCacheControl.getSnapshot().paused);
  const imageObserverRef = useRef<IntersectionObserver | null>(null);
  const observedImageSectionsRef = useRef<WeakSet<Element>>(new WeakSet());
  const observedImageCountRef = useRef(0);
  const nearImagesRef = useRef<Set<HTMLImageElement>>(new Set());
  const pendingObservedImagesRef = useRef<Set<HTMLImageElement>>(new Set());
  const imageViewportChangeRef = useRef<() => void>(() => undefined);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const switchRequestRef = useRef<object | null>(null);

  const stopGuideSearchAlignment = () => {
    guideSearchAlignmentStopRef.current?.();
    guideSearchAlignmentStopRef.current = null;
  };

  const clearGuideSearchHighlight = () => {
    if (guideSearchHighlightTimerRef.current !== null) {
      clearTimeout(guideSearchHighlightTimerRef.current);
      guideSearchHighlightTimerRef.current = null;
    }
    const range = guideSearchHighlightRangeRef.current;
    guideSearchHighlightRangeRef.current = null;
    const selection = window.getSelection();
    if (range && selection && selectionMatchesRange(selection, range)) {
      selection.removeAllRanges();
    }
  };

  const highlightGuideSearchRange = (range: Range) => {
    clearGuideSearchHighlight();
    const selection = window.getSelection();
    if (!selection) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
    guideSearchHighlightRangeRef.current = range;
    guideSearchHighlightTimerRef.current = setTimeout(
      clearGuideSearchHighlight,
      SEARCH_HIGHLIGHT_MS,
    );
  };

  const openGuideSwitcher = () => {
    if (guideSwitcherOpen) {
      return;
    }
    setGuideSearchOpen(false);
    setGuideSwitcherOpen(true);
  };

  const closeGuideSwitcher = () => {
    switchRequestRef.current = null;
    setSwitchPending(null);
    setGuideSwitcherOpen(false);
    requestAnimationFrame(() => {
      focusWithoutScrolling(scrollerRef.current);
    });
  };

  const openGuideSearch = () => {
    const guide = loaded?.guide;
    if (!guide || loading || refreshPending) {
      return;
    }
    if (guideSearchIndexRef.current?.guide !== guide) {
      // ponytail: build the bounded index on demand; split it across frames only
      // if Steam Deck profiling shows a visible first-search stall.
      guideSearchIndexRef.current = {
        guide,
        index: buildGuideSearchIndex(guide),
      };
    }
    setGuideSearchOpen(true);
  };

  const closeGuideSearch = () => {
    setGuideSearchOpen(false);
    requestAnimationFrame(() => {
      focusWithoutScrolling(
        guideSearchButtonRef.current ?? scrollerRef.current,
      );
    });
  };

  const cancelReader = (event: CustomEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (guideSwitcherOpen) {
      closeGuideSwitcher();
    } else if (guideSearchOpen) {
      closeGuideSearch();
    } else {
      onClose();
    }
  };
  const restoringRef = useRef(false);
  const stopRestoreRef = useRef<(() => void) | null>(null);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const latestQueuedSaveRef = useRef<{
    signature: string;
    promise: Promise<boolean>;
    token: object;
  } | null>(null);
  const pendingSaveCountRef = useRef(0);
  const refreshScrolledRef = useRef(false);

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

  useLayoutEffect(() => {
    if (!guideSwitcherOpen) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      focusWithoutScrolling(guideSwitcherCloseRef.current);
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [guideSwitcherOpen]);

  useEffect(() => {
    if (!identity) {
      return;
    }
    let canceled = false;
    setGuideLibrary(null);
    setGuideSwitcherError(null);
    void loadGuideLibrary(identity.appId)
      .then((entries) => {
        if (!canceled) {
          setGuideLibrary(entries);
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) {
          setGuideSwitcherError(errorMessage(reason));
        }
      });
    return () => {
      canceled = true;
    };
  }, [guideSwitcherRevision, identity?.appId, loadGuideLibrary]);

  useEffect(() => {
    if (guideSearchIndexRef.current?.guide !== loaded?.guide) {
      guideSearchIndexRef.current = null;
      pendingGuideSearchJumpRef.current = null;
      stopGuideSearchAlignment();
      clearGuideSearchHighlight();
      setGuideSearchOpen(false);
      setGuideSearchQuery("");
      setActiveGuideSearchResultIndex(null);
    }
  }, [loaded?.guide]);

  useEffect(
    () => () => {
      switchRequestRef.current = null;
      stopGuideSearchAlignment();
      clearGuideSearchHighlight();
    },
    [identity?.appId, identity?.guideId],
  );

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
          let displaySnapshot = retainGuideForStaleRefresh(
            loadedRef.current,
            snapshot,
            refreshGeneration > 0,
          );
          if (
            refreshScrolledRef.current &&
            scrollerRef.current &&
            contentRef.current
          ) {
            const captured = captureReaderPosition(
              scrollerRef.current,
              contentRef.current,
              anchorIndexRef.current ?? undefined,
            );
            void persistPosition(captured);
            displaySnapshot = {
              ...displaySnapshot,
              position: {
                ...captured,
                updatedAt: 0,
              },
            };
          }
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
          refreshScrolledRef.current = false;
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
      : Math.min(loaded.guide.sections.length, 1)
    : 0;
  const renderedSectionCountRef = useRef(renderedSectionCount);

  useEffect(() => {
    const guide = loaded?.guide ?? null;
    const total = guide?.sections.length ?? 0;
    let scheduledCount = Math.min(total, 1);
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
      scheduledCount = Math.min(total, scheduledCount + SECTION_RENDER_BATCH);
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
    renderedSectionCountRef.current = renderedSectionCount;
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

  const persistPosition = useCallback(
    async (
      capturedPosition?: ReturnType<typeof captureReaderPosition>,
    ): Promise<boolean> => {
      if (
        !checkpoint.canPersist ||
        !identity ||
        !scrollerRef.current ||
        !contentRef.current
      ) {
        return true;
      }
      const captured =
        capturedPosition ??
        captureReaderPosition(
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
      const operation = cache
        .savePosition(identity, captured)
        .then(() => {
          lastSavedSignatureRef.current = signature;
          setSaveError(null);
          return true;
        })
        .catch((reason: unknown) => {
          setSaveError(errorMessage(reason));
          return false;
        })
        .finally(() => {
          pendingSaveCountRef.current -= 1;
          if (latestQueuedSaveRef.current?.token === token) {
            latestQueuedSaveRef.current = null;
          }
        });
      latestQueuedSaveRef.current = { signature, promise: operation, token };
      return operation;
    },
    [cache, checkpoint, identity?.appId, identity?.guideId],
  );

  const retrySavePosition = async (): Promise<void> => {
    if (saveRetryPending) {
      return;
    }
    setSaveRetryPending(true);
    try {
      await persistPosition();
    } finally {
      setSaveRetryPending(false);
    }
  };

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
    if (!scroller || !content || !loaded) {
      restoringRef.current = false;
      checkpoint.block();
      return;
    }
    if (!position) {
      restoringRef.current = false;
      if (loaded.positionWarning === null) {
        checkpoint.settle();
      } else {
        checkpoint.block();
      }
      if (identity) {
        performance.markPositionSettled(
          identity,
          loaded?.positionWarning ? "unavailable" : "skipped",
        );
      }
      focusWithoutScrolling(scroller);
      return;
    }

    cancelRestore();
    checkpoint.block();
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
        renderedSectionCountRef.current >= loaded.guide.sections.length;
      const maxScrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const target = Math.min(position.scrollTop, maxScrollTop);
      const pixelFallbackReady = Math.abs(scroller.scrollTop - target) <= 1;
      return readerRestoreCanSettle(
        allSectionsRendered,
        position.anchorText !== null,
        anchorReady,
        pixelFallbackReady,
      );
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
          checkpoint.settle();
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

    const interactionEvents = ["wheel", "touchmove", "pointerdown", "keydown"];
    const onInteraction = (event: Event) => {
      if (!isReaderScrollInteraction(event, scroller)) {
        return;
      }
      checkpoint.intendScroll();
      failAndCancelRestore("用户在阅读位置稳定前开始操作");
    };
    for (const event of interactionEvents) {
      scroller.addEventListener(event, onInteraction, true);
    }
    focusWithoutScrolling(scroller);

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
    checkpoint,
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
      if (checkpoint.canPersist) {
        void persistPosition();
      } else if (identity && loadedRef.current?.position) {
        performance.failIdentity(identity, "页面在阅读位置稳定前关闭");
      }
      cancelRestore();
    },
    [
      cancelRestore,
      checkpoint,
      identity?.appId,
      identity?.guideId,
      performance,
      persistPosition,
    ],
  );

  const onScroll = () => {
    if (restoringRef.current || loading) {
      return;
    }
    checkpoint.didScroll();
    if (!checkpoint.canPersist) {
      return;
    }
    if (refreshPending) {
      refreshScrolledRef.current = true;
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
    if (!scroller || loading) {
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
    stopGuideSearchAlignment();
    failAndCancelRestore("用户在阅读位置稳定前翻页");
    checkpoint.intendScroll();
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
    stopGuideSearchAlignment();
    imageCacheControl.resume();
    refreshScrolledRef.current = false;
    setRefreshPending(true);
    if (!restoringRef.current) {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const saved = await persistPosition();
      if (!saved) {
        refreshScrolledRef.current = false;
        setRefreshPending(false);
        return;
      }
    }
    setRefreshGeneration((generation) => generation + 1);
  };

  const switchGuide = async (entry: GuideLibraryEntry) => {
    if (!identity || entry.appId !== identity.appId || switchPending !== null) {
      return;
    }

    stopGuideSearchAlignment();

    const target = { appId: identity.appId, guideId: entry.guideId };
    const targetKey = makeGuideKey(target);
    const request = {};
    switchRequestRef.current = request;
    setSwitchPending(targetKey);
    setGuideSwitcherError(null);
    try {
      await cache.load(target);
      if (switchRequestRef.current !== request) {
        return;
      }
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!(await persistPosition())) {
        if (switchRequestRef.current === request) {
          setGuideSwitcherError("当前指南位置保存失败，未切换指南。");
        }
        return;
      }
      if (switchRequestRef.current !== request) {
        return;
      }
      await onSwitchGuide(target);
      if (switchRequestRef.current === request) {
        closeGuideSwitcher();
      }
    } catch (reason: unknown) {
      if (switchRequestRef.current === request) {
        setGuideSwitcherError(`指南打开失败：${errorMessage(reason)}`);
      }
    } finally {
      if (switchRequestRef.current === request) {
        switchRequestRef.current = null;
        setSwitchPending(null);
      }
    }
  };

  const retryReaderPosition = async (repair: boolean) => {
    if (!identity || positionRepairBusy) {
      return;
    }
    stopGuideSearchAlignment();
    setPositionRepairMode(repair ? "repair" : "retry");
    try {
      const repairMessage = repair ? await onRepairPositions() : null;
      const snapshot = await cache.retryPosition(identity);
      setLoaded(snapshot);
      const warnings = [repairMessage, snapshot.positionWarning].filter(
        (warning): warning is string => warning !== null,
      );
      setLoadWarning(warnings.length > 0 ? warnings.join("；") : null);
    } catch (reason: unknown) {
      setLoadWarning(`阅读位置恢复失败，正文仍可使用：${errorMessage(reason)}`);
    } finally {
      setPositionRepairMode(null);
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
      checkpoint.intendScroll();
      scroller.scrollTop += sectionRect.top - scrollerRect.top;
      focusWithoutScrolling(scroller);
      onScroll();
      return true;
    }
    return false;
  };

  const renderThroughSection = (sectionId: string): boolean => {
    const guide = loaded?.guide;
    const sectionIndex = guide?.sections.findIndex(
      (section) => section.id === sectionId,
    );
    if (!guide || sectionIndex === undefined || sectionIndex < 0) {
      return false;
    }
    setSectionRenderState((current) => ({
      guide,
      count:
        current.guide === guide
          ? Math.max(current.count, sectionIndex + 1)
          : sectionIndex + 1,
    }));
    return true;
  };

  const jumpToSection = (sectionId: string) => {
    stopGuideSearchAlignment();
    failAndCancelRestore("用户在阅读位置稳定前跳转章节");
    if (scrollToRenderedSection(sectionId)) {
      return;
    }
    if (renderThroughSection(sectionId)) {
      pendingSectionJumpRef.current = sectionId;
    }
  };

  useLayoutEffect(() => {
    const pendingSection = pendingSectionJumpRef.current;
    if (pendingSection && scrollToRenderedSection(pendingSection)) {
      pendingSectionJumpRef.current = null;
    }
  }, [renderedSectionCount]);

  const scrollToGuideSearchResult = (result: GuideSearchResult): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }
    if (result.kind === "guide-title") {
      stopGuideSearchAlignment();
      clearGuideSearchHighlight();
      checkpoint.intendScroll();
      scroller.scrollTop = 0;
      onScroll();
      return true;
    }
    anchorIndexRef.current?.refresh();
    const section = result.sectionId
      ? (anchorIndexRef.current?.sectionElement(result.sectionId) ?? null)
      : null;
    const target =
      result.kind === "section-title"
        ? section?.querySelector<HTMLElement>(".grip-reader-section-title")
        : section?.querySelector<HTMLElement>("[data-guide-search-body]");
    if (!target) {
      return false;
    }
    const range = locateGuideSearchRange(
      target,
      guideSearchQuery,
      result.occurrence,
    );
    if (!range) {
      return false;
    }

    stopGuideSearchAlignment();
    highlightGuideSearchRange(range);
    const align = (force: boolean) => {
      if (!range.startContainer.isConnected) {
        return;
      }
      const nextScrollTop = Math.max(
        0,
        Math.min(
          scroller.scrollTop +
            range.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            SEARCH_SCROLL_MARGIN,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        ),
      );
      if (!force && Math.abs(nextScrollTop - scroller.scrollTop) <= 1) {
        return;
      }
      checkpoint.intendScroll();
      scroller.scrollTop = nextScrollTop;
      onScroll();
    };
    align(true);

    const content = contentRef.current;
    if (content) {
      const onLayoutChange = () => align(false);
      const observer = new ResizeObserver(onLayoutChange);
      let stopped = false;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const interactionEvents = [
        "wheel",
        "touchmove",
        "pointerdown",
        "keydown",
      ];
      const stop = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (deadline !== null) {
          clearTimeout(deadline);
        }
        observer.disconnect();
        content.removeEventListener("load", onLayoutChange, true);
        content.removeEventListener("error", onLayoutChange, true);
        for (const event of interactionEvents) {
          scroller.removeEventListener(event, onInteraction, true);
        }
        if (imageViewportChangeRef.current === onLayoutChange) {
          imageViewportChangeRef.current = () => undefined;
        }
        if (guideSearchAlignmentStopRef.current === stop) {
          guideSearchAlignmentStopRef.current = null;
        }
      };
      const onInteraction = (event: Event) => {
        if (isReaderScrollInteraction(event, scroller)) {
          stop();
        }
      };
      observer.observe(content);
      content.addEventListener("load", onLayoutChange, true);
      content.addEventListener("error", onLayoutChange, true);
      for (const event of interactionEvents) {
        scroller.addEventListener(event, onInteraction, true);
      }
      imageViewportChangeRef.current = onLayoutChange;
      guideSearchAlignmentStopRef.current = stop;
      deadline = setTimeout(() => {
        align(false);
        stop();
      }, SEARCH_ALIGNMENT_TIMEOUT_MS);
    }
    return true;
  };

  const jumpToGuideSearchResult = (
    result: GuideSearchResult,
    index: number,
  ) => {
    if (loading || refreshPending) {
      return;
    }
    failAndCancelRestore("用户在阅读位置稳定前跳转搜索命中");
    stopGuideSearchAlignment();
    pendingGuideSearchJumpRef.current = result;
    if (activeGuideSearchResultIndex !== index) {
      setActiveGuideSearchResultIndex(index);
      if (result.sectionId) {
        renderThroughSection(result.sectionId);
      }
      return;
    }
    if (scrollToGuideSearchResult(result)) {
      pendingGuideSearchJumpRef.current = null;
    } else if (!result.sectionId || !renderThroughSection(result.sectionId)) {
      pendingGuideSearchJumpRef.current = null;
    }
  };

  useLayoutEffect(() => {
    const pendingResult = pendingGuideSearchJumpRef.current;
    if (pendingResult && scrollToGuideSearchResult(pendingResult)) {
      pendingGuideSearchJumpRef.current = null;
    }
  }, [activeGuideSearchResultIndex, renderedSectionCount]);

  const cachedGuideSearchIndex = guideSearchIndexRef.current;
  const activeGuideSearchIndex =
    cachedGuideSearchIndex && cachedGuideSearchIndex.guide === loaded?.guide
      ? cachedGuideSearchIndex.index
      : null;
  const guideSearchResponse = useMemo(
    () =>
      activeGuideSearchIndex
        ? searchGuideIndex(activeGuideSearchIndex, guideSearchQuery)
        : { matches: [], truncated: false },
    [activeGuideSearchIndex, guideSearchQuery],
  );
  const guideSearchResults = guideSearchResponse.matches;
  const moveGuideSearchResult = (direction: -1 | 1) => {
    const nextIndex =
      activeGuideSearchResultIndex === null
        ? direction === 1
          ? 0
          : -1
        : activeGuideSearchResultIndex + direction;
    const result = guideSearchResults[nextIndex];
    if (result) {
      jumpToGuideSearchResult(result, nextIndex);
    }
  };

  if (!identity) {
    return (
      <div style={{ color: "white", padding: 48 }}>
        <h1>GRIP Reader</h1>
        <p>尚未选择指南。请从 Decky 打开 GRIP，然后选择“继续阅读”。</p>
        <Button onClick={onClose}>返回</Button>
      </div>
    );
  }

  const currentSnapshot =
    loaded?.guide.guideId === identity.guideId ? loaded : null;
  const currentSectionTitle = currentSnapshot?.position?.sectionId
    ? (currentSnapshot.guide.sections.find(
        (section) => section.id === currentSnapshot.position?.sectionId,
      )?.title ?? null)
    : null;
  const currentGuideEntry: GuideLibraryEntry = {
    appId: identity.appId,
    guideId: identity.guideId,
    updatedAt:
      currentSnapshot?.position?.updatedAt ??
      currentSnapshot?.guide.fetchedAt ??
      0,
    cache: currentSnapshot
      ? {
          title: currentSnapshot.guide.title,
          author: currentSnapshot.guide.author,
          fetchedAt: currentSnapshot.guide.fetchedAt,
          sectionTitle: currentSectionTitle,
          stale: currentSnapshot.guide.stale,
        }
      : null,
  };
  const guideChoices = guideLibrary
    ? guideChoicesForReader(guideLibrary, currentGuideEntry)
    : null;
  const readerWarning =
    restoreWarning ?? loadWarning ?? loaded?.positionWarning ?? null;

  return (
    <Focusable
      onCancel={cancelReader}
      onOptionsActionDescription={
        !guideSwitcherOpen && !guideSearchOpen && switchPending === null
          ? "切换指南"
          : undefined
      }
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (
          !event.detail.is_repeat &&
          !guideSearchOpen &&
          switchPending === null
        ) {
          openGuideSwitcher();
        }
      }}
      style={{
        background: "linear-gradient(180deg, #16202b 0%, #0d141c 100%)",
        boxSizing: "border-box",
        color: "#dcdedf",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        paddingTop: STEAM_TOP_BAR_HEIGHT,
        position: "relative",
      }}
    >
      <style>{READER_CSS}</style>
      {guideSwitcherOpen && (
        <Focusable
          aria-label="切换指南"
          aria-modal="true"
          className="grip-reader-guide-switcher"
          role="dialog"
          style={{
            background: "linear-gradient(180deg, #16202b 0%, #0d141c 100%)",
            bottom: 0,
            display: "flex",
            flexDirection: "column",
            left: 0,
            padding: "24px 28px",
            position: "absolute",
            right: 0,
            top: STEAM_TOP_BAR_HEIGHT,
            zIndex: 10,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 12,
              marginBottom: 18,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 24, fontWeight: 700 }}>本游戏指南</div>
              <div style={{ opacity: 0.7 }}>
                仅显示 AppID {identity.appId} 的已记录指南
              </div>
            </div>
            <Button
              onClick={closeGuideSwitcher}
              preferredFocus
              ref={guideSwitcherCloseRef}
            >
              关闭
            </Button>
          </div>
          {guideLibrary === null && !guideSwitcherError && (
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flex: 1,
                gap: 12,
                justifyContent: "center",
              }}
            >
              <Spinner /> 正在读取本游戏指南…
            </div>
          )}
          {guideSwitcherError && (
            <div role="alert" style={{ color: "#ff8a8a", marginBottom: 16 }}>
              <div>{guideSwitcherError}</div>
              <Button
                disabled={switchPending !== null}
                onClick={() =>
                  setGuideSwitcherRevision((revision) => revision + 1)
                }
              >
                重新读取指南列表
              </Button>
            </div>
          )}
          {guideChoices && (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {guideChoices.map((entry) => {
                const guideKey = makeGuideKey(entry);
                const current = entry.guideId === identity.guideId;
                const pending = switchPending === guideKey;
                const style = {
                  boxSizing: "border-box" as const,
                  marginBottom: 12,
                  minHeight: 72,
                  padding: "12px 16px",
                  textAlign: "left" as const,
                  width: "100%",
                };
                const content = (
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                      {pending ? (
                        <BusyLabel>正在准备并打开…</BusyLabel>
                      ) : (
                        `${current ? "正在阅读 · " : ""}${entry.cache?.title ?? `Steam 指南 ${entry.guideId}`}`
                      )}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 5, opacity: 0.72 }}>
                      {guideChoiceDetails(entry)}
                    </div>
                  </div>
                );
                if (current) {
                  return (
                    <div aria-current="page" key={guideKey} style={style}>
                      {content}
                    </div>
                  );
                }
                return (
                  <Button
                    aria-label={`打开指南：${entry.cache?.title ?? entry.guideId}`}
                    disabled={switchPending !== null}
                    key={guideKey}
                    onClick={() => void switchGuide(entry)}
                    style={style}
                  >
                    {content}
                  </Button>
                );
              })}
            </div>
          )}
        </Focusable>
      )}

      {readerWarning && (
        <div
          aria-hidden={guideSwitcherOpen}
          inert={guideSwitcherOpen ? true : undefined}
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
                {positionRepairMode === "retry" ? (
                  <BusyLabel>正在处理…</BusyLabel>
                ) : (
                  "重试位置"
                )}
              </Button>
              <Button
                disabled={positionRepairBusy}
                onClick={() => void retryReaderPosition(true)}
              >
                {positionRepairMode === "repair" ? (
                  <BusyLabel>正在处理…</BusyLabel>
                ) : (
                  "备份并重置"
                )}
              </Button>
            </>
          )}
        </div>
      )}

      {loading && !loaded ? (
        <div
          aria-hidden={guideSwitcherOpen}
          inert={guideSwitcherOpen ? true : undefined}
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
        <div
          aria-hidden={guideSwitcherOpen}
          inert={guideSwitcherOpen ? true : undefined}
          style={{ padding: 48 }}
        >
          <h2>无法打开该指南</h2>
          <p>{error}</p>
          <Button disabled={refreshPending} onClick={() => void refreshGuide()}>
            {refreshPending ? <BusyLabel>重试中…</BusyLabel> : "重试"}
          </Button>
        </div>
      ) : loaded ? (
        <div
          aria-hidden={guideSwitcherOpen}
          inert={guideSwitcherOpen ? true : undefined}
          style={{ display: "flex", flex: 1, minHeight: 0 }}
        >
          <Focusable
            aria-label="指南正文"
            ref={scrollerRef}
            flow-children="none"
            onButtonDown={onReaderButton}
            onGamepadDirection={onReaderDirection}
            onScroll={onScroll}
            preferredFocus={!guideSwitcherOpen}
            style={{
              flex: 1,
              minWidth: 0,
              outline: "none",
              overflowY: loading || guideSwitcherOpen ? "hidden" : "auto",
              scrollBehavior: "auto",
            }}
            role="region"
            tabIndex={0}
          >
            <div
              className="grip-reader-content grip-reader-guide-enter"
              key={loaded.guide.guideId}
              ref={contentRef}
            >
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
                    <GuideSectionBody html={section.html} />
                  </section>
                ))}
            </div>
          </Focusable>
          <div
            aria-label={guideSearchOpen ? "指南搜索" : "指南目录"}
            className="grip-reader-toc"
            role={guideSearchOpen ? "search" : "navigation"}
            style={{
              background: "rgba(7, 12, 18, 0.48)",
              borderLeft: "1px solid #314252",
              boxSizing: "border-box",
              flex: guideSearchOpen ? "0 0 320px" : "0 0 88px",
              overflowY: "auto",
              padding: "18px 6px",
            }}
          >
            {guideSearchOpen ? (
              <>
                <Button
                  onClick={closeGuideSearch}
                  ref={guideSearchButtonRef}
                  style={{
                    boxSizing: "border-box",
                    fontSize: 16,
                    lineHeight: "22px",
                    marginBottom: 12,
                    minWidth: 0,
                    overflow: "hidden",
                    padding: "8px",
                    width: "100%",
                  }}
                >
                  关闭搜索
                </Button>
                <TextField
                  bShowClearAction
                  focusOnMount
                  label="搜索指南正文"
                  onChange={(event) => {
                    pendingGuideSearchJumpRef.current = null;
                    stopGuideSearchAlignment();
                    clearGuideSearchHighlight();
                    setActiveGuideSearchResultIndex(null);
                    setGuideSearchQuery(event.currentTarget.value);
                  }}
                  value={guideSearchQuery}
                />
                {guideSearchQuery.trim().length === 0 ? (
                  <div style={{ margin: "14px 8px", opacity: 0.72 }}>
                    输入标题、章节或正文关键词。
                  </div>
                ) : guideSearchResults.length === 0 ? (
                  <div style={{ margin: "14px 8px", opacity: 0.72 }}>
                    没有匹配的正文。
                  </div>
                ) : (
                  <>
                    <div
                      style={{
                        alignItems: "center",
                        display: "flex",
                        gap: 6,
                        margin: "12px 0",
                      }}
                    >
                      <Button
                        aria-label="上一个搜索命中"
                        disabled={
                          loading ||
                          refreshPending ||
                          activeGuideSearchResultIndex === null ||
                          activeGuideSearchResultIndex === 0
                        }
                        onClick={() => moveGuideSearchResult(-1)}
                      >
                        上一个
                      </Button>
                      <div
                        aria-live="polite"
                        style={{ flex: 1, textAlign: "center" }}
                      >
                        {activeGuideSearchResultIndex === null
                          ? `共 ${guideSearchResults.length} 个`
                          : `${activeGuideSearchResultIndex + 1} / ${guideSearchResults.length}`}
                      </div>
                      <Button
                        aria-label="下一个搜索命中"
                        disabled={
                          loading ||
                          refreshPending ||
                          activeGuideSearchResultIndex ===
                            guideSearchResults.length - 1
                        }
                        onClick={() => moveGuideSearchResult(1)}
                      >
                        下一个
                      </Button>
                    </div>
                    {guideSearchResponse.truncated && (
                      <div
                        role="status"
                        style={{ margin: "8px", opacity: 0.72 }}
                      >
                        匹配过多，仅显示前 {guideSearchResults.length}{" "}
                        个，请继续输入关键词。
                      </div>
                    )}
                    {guideSearchResults.map((result, index) => (
                      <Button
                        aria-current={
                          activeGuideSearchResultIndex === index
                            ? "location"
                            : undefined
                        }
                        aria-label={`跳转到搜索结果 ${index + 1}：${result.title}`}
                        disabled={loading || refreshPending}
                        key={`${result.kind}:${result.sectionId}:${result.occurrence}`}
                        onClick={() => jumpToGuideSearchResult(result, index)}
                        style={{
                          boxSizing: "border-box",
                          marginBottom: 8,
                          minWidth: 0,
                          padding: "10px",
                          textAlign: "left",
                          width: "100%",
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{result.title}</div>
                        <div style={{ fontSize: 13, opacity: 0.7 }}>
                          {result.kind === "guide-title"
                            ? "指南标题"
                            : result.kind === "section-title"
                              ? "章节标题"
                              : "正文匹配"}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            marginTop: 4,
                            opacity: 0.82,
                          }}
                        >
                          {result.snippet}
                        </div>
                      </Button>
                    ))}
                  </>
                )}
              </>
            ) : (
              <>
                <Button
                  disabled={loading || refreshPending}
                  onClick={openGuideSearch}
                  ref={guideSearchButtonRef}
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
                  搜索
                </Button>
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
                  {refreshPending ? <BusyLabel>更新中…</BusyLabel> : "更新"}
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
              </>
            )}
          </div>
        </div>
      ) : null}

      {saveError && (
        <div
          aria-hidden={guideSwitcherOpen}
          inert={guideSwitcherOpen ? true : undefined}
          role="alert"
          style={{
            background: "#6d2525",
            bottom: 12,
            padding: "8px 14px",
            position: "absolute",
            right: 12,
          }}
        >
          阅读位置保存失败：{saveError}
          <Button
            disabled={saveRetryPending}
            onClick={() => void retrySavePosition()}
          >
            {saveRetryPending ? <BusyLabel>正在保存…</BusyLabel> : "重试保存"}
          </Button>
        </div>
      )}
    </Focusable>
  );
}
