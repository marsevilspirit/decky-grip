import { Button, Focusable, GamepadButton, type GamepadEvent } from "@decky/ui";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

export interface ReaderPreviewImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export function GuideImageViewer({
  image,
  images,
  onClose,
}: {
  image: ReaderPreviewImage;
  images?: ReaderPreviewImage[];
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fitButton = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => {
    const unique = new Map(
      (images ?? [image]).map((entry) => [entry.src, entry]),
    );
    if (!unique.has(image.src)) unique.set(image.src, image);
    return [...unique.values()];
  }, [image, images]);
  const [selectedSrc, setSelectedSrc] = useState(image.src);
  const current = choices.find((entry) => entry.src === selectedSrc) ?? image;
  const index = choices.findIndex((entry) => entry.src === current.src);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const fit = (initial = false) => {
    const view = viewport.current;
    if (!view) return;
    const fitted = Math.min(
      1,
      Math.max(1, view.clientWidth - 32) / current.width,
      initial && current.height > current.width
        ? 1
        : Math.max(1, view.clientHeight - 32) / current.height,
    );
    pendingScroll.current = { left: 0, top: 0 };
    setScale(fitted);
    view.scrollTop = view.scrollLeft = 0;
  };
  const zoom = (factor: number) => {
    const view = viewport.current;
    const next = Math.min(8, Math.max(0.01, scale * factor));
    if (view) {
      const centered = (scroll: number, size: number, pixels: number) =>
        Math.max(
          0,
          ((scroll + size / 2 - Math.max(0, size - pixels * scale) / 2) *
            next) /
            scale +
            Math.max(0, size - pixels * next) / 2 -
            size / 2,
        );
      pendingScroll.current = {
        left: centered(view.scrollLeft, view.clientWidth, current.width),
        top: centered(view.scrollTop, view.clientHeight, current.height),
      };
    }
    setScale(next);
  };
  const switchImage = (delta: number) => {
    const next = choices[index + delta];
    if (next) setSelectedSrc(next.src);
  };
  const focusTargets = () => [
    ...(root.current?.querySelectorAll<HTMLElement>(
      '.grip-image-control:not(:disabled):not([aria-disabled="true"]), .grip-image-viewport',
    ) ?? []),
  ];
  useLayoutEffect(() => {
    setSelectedSrc(image.src);
  }, [image.src]);
  useLayoutEffect(() => {
    drag.current = null;
    setFailed(false);
    fit(true);
    viewport.current?.focus({ preventScroll: true });
  }, [current.src]);
  useLayoutEffect(() => {
    const view = viewport.current;
    const position = pendingScroll.current;
    if (view && position) {
      view.scrollLeft = position.left;
      view.scrollTop = position.top;
      pendingScroll.current = null;
    }
  }, [scale]);
  const direction = (event: GamepadEvent) => {
    const view = viewport.current;
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(80, view.clientHeight * 0.2);
    const maxTop = Math.max(
      0,
      view.scrollHeight - view.clientHeight,
      current.height * scale - view.clientHeight,
    );
    const maxLeft = Math.max(
      0,
      view.scrollWidth - view.clientWidth,
      current.width * scale - view.clientWidth,
    );
    if (event.detail.button === GamepadButton.DIR_UP)
      view.scrollTop = Math.max(0, view.scrollTop - step);
    if (event.detail.button === GamepadButton.DIR_DOWN) {
      if (view.scrollTop >= maxTop - 1) {
        fitButton.current?.focus({ preventScroll: true });
      } else {
        view.scrollTop = Math.min(maxTop, view.scrollTop + step);
      }
    }
    if (event.detail.button === GamepadButton.DIR_LEFT)
      view.scrollLeft = Math.max(0, view.scrollLeft - step);
    if (event.detail.button === GamepadButton.DIR_RIGHT)
      view.scrollLeft = Math.max(0, Math.min(maxLeft, view.scrollLeft + step));
  };
  return (
    <Focusable
      ref={root}
      className="grip-image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片全屏查看"
      onCancelActionDescription="返回正文"
      onSecondaryActionDescription="适应屏幕"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!(event as GamepadEvent).detail?.is_repeat) onClose();
      }}
      onSecondaryButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.detail.is_repeat) fit();
      }}
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onButtonDown={(event) => {
        const button = event.detail.button;
        if (
          [
            GamepadButton.BUMPER_LEFT,
            GamepadButton.BUMPER_RIGHT,
            GamepadButton.TRIGGER_LEFT,
            GamepadButton.TRIGGER_RIGHT,
          ].includes(button)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.detail.is_repeat) return;
          if (button === GamepadButton.BUMPER_LEFT) zoom(1 / 1.5);
          else if (button === GamepadButton.BUMPER_RIGHT) zoom(1.5);
          else switchImage(button === GamepadButton.TRIGGER_LEFT ? -1 : 1);
        }
      }}
      onKeyDown={(event) => {
        if (["Escape", "+", "=", "-"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          if (event.key === "Escape") onClose();
          else zoom(event.key === "-" ? 1 / 1.5 : 1.5);
        } else if (event.key === "Tab") {
          const targets = focusTargets();
          const focused = targets.indexOf(
            event.currentTarget.ownerDocument.activeElement as HTMLElement,
          );
          const next =
            (focused + (event.shiftKey ? -1 : 1) + targets.length) %
            targets.length;
          if (targets[next]) {
            event.preventDefault();
            event.stopPropagation();
            targets[next].focus({ preventScroll: true });
          }
        }
      }}
      style={{
        position: "fixed",
        inset: "40px 0 0",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        background: "#080d13",
        paddingBottom: 56,
      }}
    >
      <style>{`
        .grip-image-control { min-width: 0 !important; padding: 8px 12px !important; }
        .grip-image-control:is(:focus, :focus-visible, .gpfocus) {
          outline: 2px solid #72d5ff !important; outline-offset: 2px;
          background: #214561 !important; color: #fff !important;
        }
        .grip-image-control:active { background: #367391 !important; }
        @media (prefers-reduced-motion: no-preference) {
          .grip-image-control { transition: background-color 90ms ease, outline-color 90ms ease; }
          .grip-image-viewer { animation: grip-image-enter 100ms ease-out; }
        }
        @keyframes grip-image-enter { from { opacity: .7; } to { opacity: 1; } }
      `}</style>
      <Focusable
        ref={viewport}
        className="grip-image-viewport"
        tabIndex={0}
        preferredFocus
        flow-children="none"
        aria-label="图片移动区域"
        onGamepadDirection={direction}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const view = event.currentTarget;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: view.scrollLeft,
            top: view.scrollTop,
          };
          view.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          touchAction: "none",
          cursor: "grab",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: "100%",
            minHeight: "100%",
            width: current.width * scale,
            height: current.height * scale,
          }}
        >
          <img
            key={current.src}
            src={current.src}
            alt={current.alt || "指南图片"}
            draggable={false}
            onError={() => setFailed(true)}
            style={{
              display: "block",
              width: current.width * scale,
              height: current.height * scale,
              maxWidth: "none",
              flexShrink: 0,
            }}
          />
        </div>
      </Focusable>
      {failed && <div role="alert">图片暂不可用，请返回正文重试。</div>}
      <Focusable
        className="grip-image-toolbar"
        flow-children="row"
        onGamepadDirection={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const button = event.detail.button;
          if (button === GamepadButton.DIR_UP) {
            viewport.current?.focus({ preventScroll: true });
          } else if (
            button === GamepadButton.DIR_LEFT ||
            button === GamepadButton.DIR_RIGHT
          ) {
            const targets = focusTargets().slice(1);
            const focused = targets.indexOf(
              root.current?.ownerDocument.activeElement as HTMLElement,
            );
            const next = Math.max(
              0,
              Math.min(
                targets.length - 1,
                focused + (button === GamepadButton.DIR_LEFT ? -1 : 1),
              ),
            );
            targets[next]?.focus({ preventScroll: true });
          }
        }}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          justifyContent: "center",
        }}
      >
        {choices.length > 1 && (
          <>
            <Button
              className="grip-image-control"
              onClick={() => switchImage(-1)}
              disabled={index <= 0}
            >
              上一张
            </Button>
            <span aria-live="polite">
              {index + 1} / {choices.length}
            </span>
            <Button
              className="grip-image-control"
              onClick={() => switchImage(1)}
              disabled={index >= choices.length - 1}
            >
              下一张
            </Button>
          </>
        )}
        <Button
          className="grip-image-control"
          onClick={() => zoom(1 / 1.5)}
          disabled={scale <= 0.01}
        >
          缩小
        </Button>
        <span aria-live="polite">{Math.round(scale * 100)}%</span>
        <Button
          className="grip-image-control"
          onClick={() => zoom(1.5)}
          disabled={scale >= 8}
        >
          放大
        </Button>
        <Button
          ref={fitButton}
          className="grip-image-control"
          onClick={() => fit()}
        >
          适应屏幕
        </Button>
        <Button className="grip-image-control" onClick={onClose}>
          返回正文
        </Button>
      </Focusable>
      <div
        style={{
          textAlign: "center",
          opacity: 0.7,
          fontSize: 14,
          paddingBottom: 8,
        }}
      >
        方向键移动 · L1 / R1 缩放{choices.length > 1 ? " · L2 / R2 切图" : ""} ·
        X 适屏 · B 返回
      </div>
    </Focusable>
  );
}
