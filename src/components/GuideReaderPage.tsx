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

import { captureReaderPosition, restoreReaderPosition } from "../reader/anchor";
import {
  ReaderSessionCache,
  type ReaderSessionSnapshot,
} from "../reader/session-cache";
import { shortSectionTitle } from "../reader/toc-title";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

const SAVE_DELAY_MS = 400;
const RESTORE_SETTLE_MS = 5_000;
const LOADING_INDICATOR_DELAY_MS = 180;

const READER_CSS = `
.grip-reader-content { color: #dcdedf; font-size: 18px; line-height: 1.55; padding: 10px 34px 80px; }
.grip-reader-content img { display: block; max-width: 100%; height: auto; margin: 14px auto; border-radius: 4px; }
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
  onClose: () => void;
}

export function GuideReaderPage({ cache, onClose }: GuideReaderPageProps) {
  const params = useParams<{ appId?: string; guideId?: string }>();
  const identity = readIdentity(params.appId, params.guideId);
  const initialSnapshot = identity ? cache.peek(identity) : null;
  const [loaded, setLoaded] = useState<ReaderSessionSnapshot | null>(
    initialSnapshot,
  );
  const [loading, setLoading] = useState(initialSnapshot === null);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshPending, setRefreshPending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (!loading || loaded) {
      setShowLoadingIndicator(false);
      return;
    }
    const timer = setTimeout(
      () => setShowLoadingIndicator(true),
      LOADING_INDICATOR_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [loaded, loading]);

  useEffect(() => {
    if (!identity) {
      setLoaded(null);
      setLoading(false);
      return;
    }

    let canceled = false;
    const cached = cache.peek(identity);
    setLoaded(cached);
    setLoading(cached === null || refreshGeneration > 0);
    setError(null);
    setSaveError(null);
    cache
      .load(identity, { forceRefresh: refreshGeneration > 0 })
      .then((snapshot) => {
        if (!canceled) {
          const { position } = snapshot;
          lastSavedSignatureRef.current =
            position && position.updatedAt > 0
              ? JSON.stringify({
                  scrollTop: position.scrollTop,
                  sectionId: position.sectionId,
                  anchorText: position.anchorText,
                  anchorOffset: position.anchorOffset,
                })
              : null;
          setLoaded(snapshot);
        }
      })
      .catch((reason: unknown) => {
        if (!canceled && cache.peek(identity) === null) {
          setError(errorMessage(reason));
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
  }, [cache, identity?.appId, identity?.guideId, refreshGeneration]);

  const persistPosition = useCallback(async (): Promise<boolean> => {
    if (!identity || !scrollerRef.current || !contentRef.current) {
      return true;
    }
    const captured = captureReaderPosition(
      scrollerRef.current,
      contentRef.current,
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
    const restore = () => {
      if (!stopped) {
        restoreReaderPosition(scroller, content, position);
      }
    };
    const animationFrame = requestAnimationFrame(() =>
      requestAnimationFrame(restore),
    );
    const observer = new ResizeObserver(restore);
    observer.observe(content);
    const images = [...content.querySelectorAll("img")];
    for (const image of images) {
      image.addEventListener("load", restore);
      image.addEventListener("error", restore);
    }
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      stopped = true;
      cancelAnimationFrame(animationFrame);
      if (finishTimer !== null) {
        clearTimeout(finishTimer);
      }
      observer.disconnect();
      for (const image of images) {
        image.removeEventListener("load", restore);
        image.removeEventListener("error", restore);
      }
    };
    finishTimer = setTimeout(() => {
      restore();
      stop();
      restoringRef.current = false;
    }, RESTORE_SETTLE_MS);
    stopRestoreRef.current = stop;

    const interactionEvents = [
      "wheel",
      "touchmove",
      "pointerdown",
      "keydown",
      "vgp_onbuttondown",
      "vgp_ondirection",
    ];
    const onInteraction = () => cancelRestore();
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
  }, [cancelRestore, loaded]);

  useLayoutEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!restoringRef.current) {
        void persistPosition();
      }
      cancelRestore();
    },
    [cancelRestore, persistPosition],
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
    cancelRestore();
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

  const jumpToSection = (sectionId: string) => {
    cancelRestore();
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) {
      return;
    }
    const section = [
      ...content.querySelectorAll<HTMLElement>("[data-guide-section-id]"),
    ].find((candidate) => candidate.dataset.guideSectionId === sectionId);
    if (section) {
      const scrollerRect = scroller.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      scroller.scrollTop += sectionRect.top - scrollerRect.top;
      scroller.focus({ preventScroll: true });
      onScroll();
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
              {loaded.guide.sections.map((section) => (
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
            {loaded.guide.sections.map((section) => (
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
