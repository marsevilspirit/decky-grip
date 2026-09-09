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
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import type { CacheClearResult, GuideLibraryEntry } from "../backend";
import type { GuideDownloadTasks } from "../reader/download";
import { captureReaderPosition } from "../reader/anchor";
import { ReaderCheckpoint } from "../reader/checkpoint";
import {
  ReaderViewport,
  type ReaderViewportSnapshot,
} from "../reader/viewport";
import { ReaderPositioning } from "../reader/positioning";
import type { ReaderImageHydrator } from "../reader/image-hydrator";
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
import { GuideDocument } from "./GuideDocument";
import { GuideImageViewer, type ReaderPreviewImage } from "./GuideImageViewer";
import { GuideSwitcher } from "./GuideSwitcher";

const SAVE_DELAY_MS = 400;
const STEAM_TOP_BAR_HEIGHT = 40;
const LOADING_INDICATOR_DELAY_MS = 180;
const SECTION_RENDER_BATCH = 8;
const SEARCH_HIGHLIGHT_MS = 1_800;
const READER_CSS = `
@keyframes grip-guide-content-enter { from { opacity: 0.35; transform: translateX(12px); } }
@media (prefers-reduced-motion: no-preference) {
  .grip-reader-guide-enter { animation: grip-guide-content-enter 180ms ease-out; }
  .grip-reader-control { transition: background 100ms ease-out, box-shadow 100ms ease-out, transform 100ms ease-out; }
}
.grip-reader-control { border-radius: 6px; }
.grip-reader-control:focus, .grip-reader-control.gpfocus, .grip-reader-control.grip-is-focused { background: #dceefa !important; color: #102131 !important; box-shadow: inset 0 0 0 2px #67c1f5; }
.grip-reader-control:active { transform: scale(0.98); }
.grip-reader-toc[data-expanded="true"] { box-shadow: -12px 0 30px #0007; }
@media (prefers-reduced-motion: reduce) { .grip-reader-control:active { transform: none; } }
.grip-reader-toc [aria-current="location"] { box-shadow: inset 3px 0 #67c1f5; font-weight: 700; }
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusWithoutScrolling(element: HTMLElement | null | undefined): void {
  if (!element || element.closest("[inert], [hidden]")) {
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
  downloads?: GuideDownloadTasks;
  imageHydrator: ReaderImageHydrator;
  imageCacheControl: ReaderImageCacheControl;
  loadGuideLibrary: (appId: string) => Promise<GuideLibraryEntry[]>;
  onClose: () => void;
  onRepairPositions: () => Promise<string>;
  onRemoveOffline: (guideId: string) => Promise<CacheClearResult>;
  onSwitchGuide: (identity: GuideIdentity) => Promise<void>;
  performance: ReaderPerformanceTracker;
}

interface SectionRenderState {
  guide: ReaderSessionSnapshot["guide"] | null;
  count: number;
}

const noDownloadSubscription = () => () => {};

export function GuideReaderPage({
  cache,
  downloads,
  imageHydrator,
  imageCacheControl,
  loadGuideLibrary,
  onClose,
  onRepairPositions,
  onRemoveOffline,
  onSwitchGuide,
  performance,
}: GuideReaderPageProps) {
  const params = useParams<{ appId?: string; guideId?: string }>();
  const identity = readIdentity(params.appId, params.guideId);
  const downloadTask = useSyncExternalStore(
    downloads?.subscribe ?? noDownloadSubscription,
    () =>
      identity ? (downloads?.getSnapshot(identity.guideId) ?? null) : null,
  );
  const anyDownloadActive = useSyncExternalStore(
    downloads?.subscribe ?? noDownloadSubscription,
    () => downloads?.hasActive() ?? false,
  );
  const downloadProgress = downloadTask?.progress;
  const downloadActive =
    downloadTask?.phase === "downloading" ||
    downloadTask?.phase === "canceling";
  const canCancelUpdate =
    downloadTask?.phase === "downloading" && !downloadProgress?.publishing;
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
  const [offlineRemoved, setOfflineRemoved] = useState(false);
  const [navigationMode, setNavigationMode] = useState<
    "collapsed" | "toc" | "search"
  >("collapsed");
  const navigationOpen = navigationMode !== "collapsed";
  const guideSearchOpen = navigationMode === "search";
  const [previewImage, setPreviewImage] = useState<ReaderPreviewImage | null>(
    null,
  );
  const [previewImages, setPreviewImages] = useState<ReaderPreviewImage[]>([]);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const [guideLibrary, setGuideLibrary] = useState<GuideLibraryEntry[] | null>(
    null,
  );
  const [guideLibraryError, setGuideLibraryError] = useState<string | null>(
    null,
  );
  const [guideSwitcherError, setGuideSwitcherError] = useState<string | null>(
    null,
  );
  const [guideSwitcherRevision, setGuideSwitcherRevision] = useState(0);
  const [switchPending, setSwitchPending] = useState<string | null>(null);
  const [guideSearchQuery, setGuideSearchQuery] = useState("");
  const [viewportState, setViewportState] = useState<ReaderViewportSnapshot>({
    activeSectionId:
      initialSnapshot?.position?.sectionId ??
      initialSnapshot?.guide.sections[0]?.id ??
      null,
    retries: [],
    retryImage: null,
    previewImage: null,
  });
  const {
    activeSectionId,
    retries: imageRetries,
    retryImage: visibleRetryImage,
    previewImage: visiblePreviewImage,
  } = viewportState;
  const [focusedTocSection, setFocusedTocSection] = useState<string | null>(
    null,
  );
  const [imageRetryError, setImageRetryError] = useState<string | null>(null);
  const [activeGuideSearchResultIndex, setActiveGuideSearchResultIndex] =
    useState<number | null>(null);
  const [sectionRenderState, setSectionRenderState] =
    useState<SectionRenderState>(() => ({
      guide: initialSnapshot?.guide ?? null,
      count: Math.min(initialSnapshot?.guide.sections.length ?? 0, 1),
    }));
  const positionRepairBusy = positionRepairMode !== null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tocRef = useRef<HTMLDivElement | null>(null);
  const guideSearchButtonRef = useRef<HTMLDivElement | null>(null);
  const guideSearchIndexRef = useRef<{
    guide: ReaderSessionSnapshot["guide"];
    index: GuideSearchIndex;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingSectionJumpRef = useRef<string | null>(null);
  const pendingGuideSearchJumpRef = useRef<GuideSearchResult | null>(null);
  const guideSearchHighlightRangeRef = useRef<Range | null>(null);
  const guideSearchHighlightTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checkpoint] = useState(() => new ReaderCheckpoint());
  const readerRef = useRef<{
    viewport: ReaderViewport;
    positioning: ReaderPositioning;
  } | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const switchRequestRef = useRef<object | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const cancelPendingFocus = () => {
    if (focusFrameRef.current !== null)
      cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = null;
  };
  const scheduleFocus = (focus: () => void) => {
    cancelPendingFocus();
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      focus();
    });
  };
  useEffect(() => cancelPendingFocus, [identity?.appId, identity?.guideId]);

  const stopGuideSearchAlignment = () => {
    readerRef.current?.positioning.stopSearch();
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

  const hideTocTitle = () => {
    setFocusedTocSection(null);
  };

  const openGuideSwitcher = () => {
    if (guideSwitcherOpen) {
      return;
    }
    cancelPendingFocus();
    setNavigationMode("collapsed");
    hideTocTitle();
    setGuideSwitcherOpen(true);
  };

  const closeGuideSwitcher = () => {
    switchRequestRef.current = null;
    setSwitchPending(null);
    setGuideSwitcherOpen(false);
    setGuideSwitcherError(null);
    scheduleFocus(() => {
      focusWithoutScrolling(scrollerRef.current);
    });
  };

  const openGuideSearch = () => {
    const guide = loaded?.guide;
    if (!guide || loading) {
      return;
    }
    cancelPendingFocus();
    if (guideSearchIndexRef.current?.guide !== guide) {
      // ponytail: build the bounded index on demand; split it across frames only
      // if Steam Deck profiling shows a visible first-search stall.
      guideSearchIndexRef.current = {
        guide,
        index: buildGuideSearchIndex(guide),
      };
    }
    hideTocTitle();
    setNavigationMode("search");
  };

  const expandNavigation = () => {
    setNavigationMode((mode) => (mode === "collapsed" ? "toc" : mode));
  };

  const openNavigation = () => {
    if (!loaded || loading) return;
    expandNavigation();
    scheduleFocus(() => {
      const chapters = tocRef.current?.querySelectorAll<HTMLElement>(
        "[data-grip-toc-section]",
      );
      const target =
        [...(chapters ?? [])].find(
          (chapter) => chapter.dataset.gripTocSection === activeSectionId,
        ) ?? guideSearchButtonRef.current;
      focusWithoutScrolling(target);
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };

  const closeNavigation = () => {
    setNavigationMode("collapsed");
    hideTocTitle();
    scheduleFocus(() => focusWithoutScrolling(scrollerRef.current));
  };

  const closeGuideSearch = () => {
    setNavigationMode("toc");
    scheduleFocus(() => {
      focusWithoutScrolling(
        guideSearchButtonRef.current ?? scrollerRef.current,
      );
    });
  };

  const cancelReader = (event: CustomEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail?.is_repeat || ("repeat" in event && event.repeat)) return;
    if (previewImage) {
      closeImagePreview();
    } else if (guideSwitcherOpen) {
      closeGuideSwitcher();
    } else if (guideSearchOpen) {
      closeGuideSearch();
    } else if (navigationOpen) {
      closeNavigation();
    } else {
      onClose();
    }
  };
  const closeImagePreview = () => {
    setPreviewImage(null);
    scheduleFocus(() =>
      focusWithoutScrolling(
        previewReturnFocusRef.current?.isConnected
          ? previewReturnFocusRef.current
          : scrollerRef.current,
      ),
    );
  };
  const openImagePreview = (image: HTMLImageElement) => {
    if (image.dataset.gripImageState !== "ready") return;
    cancelPendingFocus();
    hideTocTitle();
    previewReturnFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      scrollerRef.current?.contains(document.activeElement)
        ? document.activeElement
        : scrollerRef.current;
    const toPreview = (element: HTMLImageElement): ReaderPreviewImage => ({
      src: element.currentSrc || element.src,
      alt: element.alt,
      width: element.naturalWidth || element.width || 1,
      height: element.naturalHeight || element.height || 1,
    });
    const candidates = new Map<string, HTMLImageElement>();
    for (const element of [
      ...(readerRef.current?.viewport.visibleImages ?? []),
      image,
    ]) {
      if (element.isConnected && element.dataset.gripImageState === "ready")
        candidates.set(element.currentSrc || element.src, element);
    }
    setPreviewImages(
      [...candidates.values()]
        .sort((left, right) =>
          left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
        )
        .map(toPreview),
    );
    setPreviewImage(toPreview(image));
  };
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

  const scheduleViewport = useCallback(
    () => readerRef.current?.viewport.schedule(),
    [],
  );

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
      return;
    }
    let canceled = false;
    setGuideLibrary((entries) =>
      entries?.every((entry) => entry.appId === identity.appId)
        ? entries
        : null,
    );
    setGuideLibraryError(null);
    void loadGuideLibrary(identity.appId)
      .then((entries) => {
        if (!canceled) {
          setGuideLibrary(entries);
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) {
          setGuideLibraryError(errorMessage(reason));
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
      if (navigationOpen) closeNavigation();
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
    setOfflineRemoved(false);
    setNavigationMode("collapsed");
    setGuideSwitcherOpen(false);
    setPreviewImage(null);
  }, [identity?.appId, identity?.guideId]);

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
              readerRef.current?.viewport.anchors ?? undefined,
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
          if (refreshGeneration > 0 && !snapshot.guide.stale) {
            setOfflineRemoved(false);
            setGuideSwitcherRevision((revision) => revision + 1);
          }
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
              downloads?.getSnapshot(identity.guideId)?.phase === "canceled"
                ? "更新已取消，继续阅读原指南。"
                : `更新失败，继续使用本地缓存：${errorMessage(reason)}`,
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
    downloads,
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
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || !loaded) {
      readerRef.current = null;
      checkpoint.block();
      return;
    }
    let positioning: ReaderPositioning | undefined;
    const viewport = new ReaderViewport(
      scroller,
      content,
      imageHydrator,
      imageCacheControl,
      setViewportState,
      () => positioning?.layoutChanged(),
    );
    positioning = new ReaderPositioning(viewport, checkpoint, (reason) => {
      if (identity) performance.failIdentity(identity, reason);
    });
    const reader = { viewport, positioning };
    readerRef.current = reader;
    return () => {
      reader.positioning.dispose();
      viewport.dispose();
    };
  }, [
    checkpoint,
    identity?.appId,
    identity?.guideId,
    loaded?.guide,
    imageHydrator,
    imageCacheControl,
    performance,
  ]);

  useLayoutEffect(() => {
    readerRef.current?.viewport.syncSections();
  }, [
    loaded?.guide,
    renderedSectionCount,
    imageHydrator,
    imageCacheControl,
    performance,
  ]);

  const showTocTitle = (sectionId: string) => {
    setFocusedTocSection(sectionId);
    expandNavigation();
  };

  const retryImage = (image: HTMLImageElement) => {
    imageCacheControl.resume();
    if (imageCacheControl.getSnapshot().paused) {
      setImageRetryError("缓存清理中，请稍后重试");
      return;
    }
    setImageRetryError(null);
    imageHydrator.retryImage(image);
  };

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
          readerRef.current?.viewport.anchors ?? undefined,
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

  useEffect(() => {
    // An update can finish after this reader was closed and reopened with its old warm snapshot.
    if (
      downloadTask?.phase !== "complete" ||
      refreshPending ||
      loading ||
      !identity
    )
      return;
    const next = cache.peek(identity);
    if (!next || next.guide === loadedRef.current?.guide) return;
    const captured =
      checkpoint.canPersist && scrollerRef.current && contentRef.current
        ? captureReaderPosition(
            scrollerRef.current,
            contentRef.current,
            readerRef.current?.viewport.anchors ?? undefined,
          )
        : null;
    if (captured) void persistPosition(captured);
    setLoaded({
      ...next,
      position: captured ? { ...captured, updatedAt: 0 } : next.position,
    });
    setGuideSwitcherRevision((revision) => revision + 1);
  }, [
    cache,
    downloadTask,
    identity?.appId,
    identity?.guideId,
    loading,
    refreshPending,
    persistPosition,
  ]);

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

  const cancelRestore = useCallback(
    () => readerRef.current?.positioning.cancelRestore(),
    [],
  );

  const failAndCancelRestore = useCallback((reason: string) => {
    readerRef.current?.positioning.cancelRestore(reason);
  }, []);

  useLayoutEffect(() => {
    const reader = readerRef.current;
    if (!loaded || !reader) {
      checkpoint.block();
      return;
    }
    reader.positioning.restore(loaded, {
      onOutcome: (outcome) => {
        if (identity) performance.markPositionSettled(identity, outcome);
      },
      onTimeout: () =>
        setRestoreWarning(
          "阅读位置在 10 秒内未稳定；正文已显示，GRIP 会继续尝试恢复。",
        ),
      onStable: () => setRestoreWarning(null),
    });
    if (
      !tocRef.current?.contains(
        reader.viewport.scroller.ownerDocument.activeElement,
      )
    )
      focusWithoutScrolling(reader.viewport.scroller);
    return () => reader.positioning.cancelRestore();
  }, [
    checkpoint,
    identity?.appId,
    identity?.guideId,
    loaded,
    performance,
    imageHydrator,
    imageCacheControl,
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
    scheduleViewport();
    if (readerRef.current?.positioning.restoring || loading) {
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
    } else if (event.detail.button === GamepadButton.DIR_RIGHT) {
      event.preventDefault();
      event.stopPropagation();
      openNavigation();
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
    if (refreshPending || loading || downloadActive) {
      return;
    }
    stopGuideSearchAlignment();
    imageCacheControl.resume();
    refreshScrolledRef.current = false;
    setRefreshPending(true);
    if (!readerRef.current?.positioning.restoring) {
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
    if (
      !identity ||
      entry.appId !== identity.appId ||
      switchRequestRef.current !== null
    ) {
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
    const index = readerRef.current?.viewport.anchors;
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
    if (navigationOpen) closeNavigation();
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
    readerRef.current?.viewport.anchors?.refresh();
    const section = result.sectionId
      ? (readerRef.current?.viewport.anchors?.sectionElement(
          result.sectionId,
        ) ?? null)
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
    readerRef.current?.positioning.search(range, onScroll);
    return true;
  };

  const jumpToGuideSearchResult = (
    result: GuideSearchResult,
    index: number,
  ) => {
    if (loading) {
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
    (downloadTask?.phase === "downloading" && downloadProgress?.error
      ? `${downloadProgress.stopped ? "空间不足，已停止后续下载" : `${downloadProgress.failed} 张图片失败，其余继续下载`}：${downloadProgress.error}。旧版仍可阅读。`
      : downloadTask?.phase === "failed" && downloadTask.error
        ? `下载未完成：${downloadTask.error}`
        : downloadTask?.phase === "canceling"
          ? "正在取消更新，等待正在保存的图片完成；原指南仍可阅读。"
          : downloadTask?.phase === "canceled"
            ? "更新已取消，继续阅读原指南。"
            : null) ??
    restoreWarning ??
    loadWarning ??
    loaded?.positionWarning ??
    null;
  const readerCovered = guideSwitcherOpen || previewImage !== null;

  return (
    <Focusable
      className="grip-reader"
      onCancel={cancelReader}
      onSecondaryActionDescription={
        !previewImage && !guideSwitcherOpen && loaded
          ? navigationOpen
            ? "返回正文"
            : "目录"
          : undefined
      }
      onSecondaryButton={(event) => {
        if (previewImage || guideSwitcherOpen || !loaded) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.detail.is_repeat) {
          if (navigationOpen) closeNavigation();
          else openNavigation();
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || previewImage || guideSwitcherOpen) return;
        if (event.key === "Escape") {
          cancelReader(event as unknown as CustomEvent);
          return;
        }
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable='true']")) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          openGuideSearch();
        }
      }}
      onOptionsActionDescription={
        !previewImage &&
        !guideSwitcherOpen &&
        !guideSearchOpen &&
        switchPending === null
          ? "切换指南"
          : undefined
      }
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (
          !previewImage &&
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
      {previewImage && (
        <GuideImageViewer
          image={previewImage}
          images={previewImages}
          onClose={closeImagePreview}
        />
      )}
      {guideSwitcherOpen && (
        <GuideSwitcher
          entries={guideChoices}
          currentGuideId={identity.guideId}
          pendingKey={switchPending}
          listError={guideLibraryError}
          error={guideSwitcherError}
          removed={offlineRemoved}
          removeDisabled={anyDownloadActive || refreshPending}
          onChoose={(entry) => void switchGuide(entry)}
          onReload={() => setGuideSwitcherRevision((revision) => revision + 1)}
          onClose={closeGuideSwitcher}
          onRemove={async (entry) => {
            if (entry.appId !== identity.appId)
              throw new Error("指南所属游戏已变化，请重新打开指南列表");
            if (downloads?.hasActive() || refreshPending)
              throw new Error("指南正在下载，完成后才能卸载离线内容");
            try {
              const result = await onRemoveOffline(entry.guideId);
              if (entry.guideId === identity.guideId) setOfflineRemoved(true);
              setGuideLibrary(
                (entries) =>
                  entries?.map((saved) =>
                    saved.guideId === entry.guideId
                      ? { ...saved, cache: null }
                      : saved,
                  ) ?? null,
              );
              return result;
            } finally {
              // A partial cleanup failure may already have removed the body.
              setGuideSwitcherRevision((revision) => revision + 1);
            }
          }}
        />
      )}

      {readerWarning && (
        <div
          role="status"
          aria-hidden={readerCovered || navigationOpen}
          inert={readerCovered || navigationOpen ? true : undefined}
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
          aria-hidden={readerCovered}
          inert={readerCovered ? true : undefined}
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
          aria-hidden={readerCovered}
          inert={readerCovered ? true : undefined}
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
          aria-hidden={readerCovered}
          inert={readerCovered ? true : undefined}
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            position: "relative",
          }}
        >
          <Focusable
            aria-label="指南正文"
            aria-hidden={navigationMode === "toc" || undefined}
            inert={navigationMode === "toc" ? true : undefined}
            ref={scrollerRef}
            flow-children="none"
            onButtonDown={onReaderButton}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.tagName === "IMG")
                openImagePreview(target as HTMLImageElement);
            }}
            onOKActionDescription={
              visibleRetryImage
                ? visibleRetryImage.dataset.gripImageState === "capacity"
                  ? "优先显示此图"
                  : "重试图片"
                : visiblePreviewImage
                  ? "查看图片"
                  : undefined
            }
            onOKButton={(event) => {
              if (
                event.detail.is_repeat ||
                (!visibleRetryImage && !visiblePreviewImage)
              )
                return;
              const target = event.target as Element | null;
              if (target?.closest?.("[data-grip-image-retry]")) return;
              event.preventDefault();
              event.stopPropagation();
              if (visibleRetryImage) retryImage(visibleRetryImage);
              else if (visiblePreviewImage)
                openImagePreview(visiblePreviewImage);
            }}
            onGamepadDirection={onReaderDirection}
            onScroll={onScroll}
            preferredFocus={!guideSwitcherOpen && !navigationOpen}
            actionDescriptionMap={{
              [GamepadButton.BUMPER_LEFT]: "上翻",
              [GamepadButton.BUMPER_RIGHT]: "下翻",
            }}
            style={{
              flex: 1,
              marginRight: 88,
              minWidth: 0,
              outline: "none",
              overflowY: loading || guideSwitcherOpen ? "hidden" : "auto",
              scrollBehavior: "auto",
            }}
            role="region"
            tabIndex={0}
          >
            <GuideDocument
              guide={loaded.guide}
              renderedSectionCount={renderedSectionCount}
              contentRef={contentRef}
            />
            {imageRetries.map(({ image, host, key, busy }) =>
              createPortal(
                <Button
                  aria-label={`重试图片：${image.alt || image.title || key}`}
                  aria-live="polite"
                  data-grip-image-retry="true"
                  disabled={busy}
                  onClick={() => retryImage(image)}
                  style={{
                    boxSizing: "border-box",
                    marginBottom: 12,
                    minWidth: 0,
                    whiteSpace: "normal",
                    width: "100%",
                  }}
                >
                  {busy ? (
                    <BusyLabel>正在重试图片…</BusyLabel>
                  ) : (
                    (imageRetryError ??
                    (image.dataset.gripImageState === "capacity"
                      ? "图片内存已满，优先显示此图"
                      : "图片读取失败，重试此图"))
                  )}
                </Button>,
                host,
                key,
              ),
            )}
          </Focusable>
          <Focusable
            aria-label={guideSearchOpen ? "指南搜索" : "指南目录"}
            aria-modal={navigationMode === "toc" || undefined}
            data-expanded={navigationOpen ? "true" : "false"}
            className="grip-reader-toc"
            onFocusCapture={(event) => {
              expandNavigation();
              const target = (event.target as HTMLElement).closest<HTMLElement>(
                "[data-grip-toc-section]",
              );
              if (target?.dataset.gripTocSection)
                showTocTitle(target.dataset.gripTocSection);
            }}
            onBlurCapture={hideTocTitle}
            ref={tocRef}
            role={
              guideSearchOpen
                ? "search"
                : navigationOpen
                  ? "dialog"
                  : "navigation"
            }
            onCancelActionDescription={
              guideSearchOpen ? "返回目录" : "返回正文"
            }
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              if (
                guideSearchOpen &&
                event.key === "Enter" &&
                (event.target as HTMLElement).matches("input") &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat)
                  moveGuideSearchResult(event.shiftKey ? -1 : 1);
              } else if (navigationMode === "toc" && event.key === "Tab") {
                const controls = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    "button, [role='button'], [tabindex]",
                  ),
                ].filter(
                  (node) =>
                    !node.closest("[hidden], [inert]") &&
                    !node.matches(":disabled, [tabindex='-1']"),
                );
                const first = controls[0];
                const last = controls[controls.length - 1];
                const edge = event.shiftKey ? first : last;
                const target = event.shiftKey ? last : first;
                if (event.target === edge && target) {
                  event.preventDefault();
                  event.stopPropagation();
                  target.focus({ preventScroll: true });
                  target.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                    behavior: "auto",
                  });
                }
              }
            }}
            onGamepadDirection={(event) => {
              const target = event.target as HTMLElement;
              if (
                event.detail.button === GamepadButton.DIR_LEFT &&
                !target.closest("input, textarea, [contenteditable='true']")
              ) {
                event.preventDefault();
                event.stopPropagation();
                closeNavigation();
              }
            }}
            style={{
              background: navigationOpen ? "#14212d" : "rgba(7, 12, 18, 0.48)",
              borderLeft: "1px solid #314252",
              boxSizing: "border-box",
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: navigationOpen ? 340 : 88,
              maxWidth: "calc(100% - 40px)",
              zIndex: navigationOpen ? 6 : 1,
              overflowY: "auto",
              padding: navigationOpen ? "16px 14px 72px" : "18px 6px 64px",
            }}
          >
            {navigationMode === "toc" && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  章节目录
                </div>
                <div
                  style={{ fontSize: 13, color: "#a7becf", marginBottom: 12 }}
                >
                  {loaded.guide.title} · {loaded.guide.sections.length} 章
                </div>
                <Button
                  className="grip-reader-control"
                  onClick={closeNavigation}
                  style={{ width: "100%", minHeight: 44 }}
                >
                  返回正文
                </Button>
              </div>
            )}
            {guideSearchOpen ? (
              <>
                <Button
                  className="grip-reader-control"
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
                        className="grip-reader-control"
                        aria-label="上一个搜索命中"
                        disabled={
                          loading ||
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
                        className="grip-reader-control"
                        aria-label="下一个搜索命中"
                        disabled={
                          loading ||
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
                        className="grip-reader-control"
                        aria-current={
                          activeGuideSearchResultIndex === index
                            ? "location"
                            : undefined
                        }
                        aria-label={`跳转到搜索结果 ${index + 1}：${result.title}`}
                        disabled={loading}
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
                  disabled={loading}
                  className="grip-reader-control"
                  aria-label="搜索指南正文"
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
                  className="grip-reader-control"
                  aria-label={
                    (canCancelUpdate ? "取消更新" : "更新指南") +
                    (downloadActive && downloadProgress
                      ? `，已保存 ${downloadProgress.completed}/${downloadProgress.total} 张图片`
                      : "")
                  }
                  disabled={
                    loading ||
                    (downloadActive ? !canCancelUpdate : refreshPending)
                  }
                  onClick={() => {
                    if (canCancelUpdate && identity) {
                      downloads?.cancel(identity.guideId);
                    } else {
                      void refreshGuide();
                    }
                  }}
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
                  {downloadActive ? (
                    canCancelUpdate ? (
                      "取消更新"
                    ) : (
                      <BusyLabel>
                        {downloadProgress?.publishing ? "保存中" : "取消中"}
                      </BusyLabel>
                    )
                  ) : refreshPending ? (
                    <BusyLabel>
                      {downloadProgress?.stopped
                        ? "已暂停"
                        : downloadProgress
                          ? `${downloadProgress.completed}/${downloadProgress.total}`
                          : "更新中…"}
                    </BusyLabel>
                  ) : (
                    "更新"
                  )}
                </Button>
                {loaded.guide.sections
                  .slice(0, renderedSectionCount)
                  .map((section) => (
                    <Button
                      className={`grip-reader-control${focusedTocSection === section.id ? " grip-is-focused" : ""}`}
                      aria-current={
                        activeSectionId === section.id ? "location" : undefined
                      }
                      aria-label={`跳转到章节：${section.title}`}
                      data-grip-toc-section={section.id}
                      disabled={loading}
                      key={section.id}
                      onClick={() => jumpToSection(section.id)}
                      onGamepadFocus={() => showTocTitle(section.id)}
                      onGamepadBlur={hideTocTitle}
                      style={{
                        boxSizing: "border-box",
                        fontSize: 16,
                        minHeight: 44,
                        lineHeight: "22px",
                        marginBottom: 8,
                        minWidth: 0,
                        overflow: "hidden",
                        padding: navigationOpen ? "12px" : "8px 2px",
                        textAlign: navigationOpen ? "left" : "center",
                        whiteSpace: navigationOpen ? "normal" : "nowrap",
                        overflowWrap: "anywhere",
                        width: "100%",
                      }}
                    >
                      {navigationOpen
                        ? section.title
                        : shortSectionTitle(section.title)}
                    </Button>
                  ))}
              </>
            )}
          </Focusable>
        </div>
      ) : null}

      {saveError && (
        <div
          aria-hidden={readerCovered || navigationOpen}
          inert={readerCovered || navigationOpen ? true : undefined}
          role="alert"
          style={{
            background: "#6d2525",
            bottom: 64,
            padding: "8px 14px",
            position: "absolute",
            right: 12,
            zIndex: 2,
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
