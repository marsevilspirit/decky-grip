import {
  DialogBodyText,
  DialogButton,
  GamepadButton,
  SimpleModal,
  gamepadDialogClasses,
  type GamepadEvent,
} from "@decky/ui";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Focusable } from "../steam/native-navigation";

export interface ReaderPreviewImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

const keyboardDirections: Record<string, GamepadButton> = {
  ArrowUp: GamepadButton.DIR_UP,
  ArrowDown: GamepadButton.DIR_DOWN,
  ArrowLeft: GamepadButton.DIR_LEFT,
  ArrowRight: GamepadButton.DIR_RIGHT,
};

interface GuideImageViewerProps {
  image: ReaderPreviewImage;
  images?: ReaderPreviewImage[];
  onClose: () => void;
}

export function GuideImageViewer(props: GuideImageViewerProps) {
  return (
    <SimpleModal active>
      <ImageViewerContent {...props} />
    </SimpleModal>
  );
}

function ImageViewerContent({ image, images, onClose }: GuideImageViewerProps) {
  const viewport = useRef<HTMLDivElement>(null);
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
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const endDrag = () => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    setDragging(false);
    if (
      pointerId !== undefined &&
      viewport.current?.hasPointerCapture(pointerId)
    )
      viewport.current.releasePointerCapture(pointerId);
  };
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const fit = (initial = false) => {
    endDrag();
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
    endDrag();
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
  useLayoutEffect(() => {
    setSelectedSrc(image.src);
  }, [image.src]);
  useLayoutEffect(() => {
    setFailed(false);
    fit(true);
  }, [current.src]);
  useLayoutEffect(() => {
    viewport.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const view = viewport.current;
    const position = pendingScroll.current;
    if (view && position) {
      view.scrollLeft = position.left;
      view.scrollTop = position.top;
      pendingScroll.current = null;
    }
  }, [scale]);
  const pan = (left: number, top: number) => {
    const view = viewport.current;
    if (!view) return;
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
    view.scrollLeft = Math.max(0, Math.min(maxLeft, left));
    view.scrollTop = Math.max(0, Math.min(maxTop, top));
  };
  // Steam consumes any result except false; an image edge yields to native focus navigation.
  const direction = (button: GamepadButton) => {
    const view = viewport.current;
    if (!view) return false;
    const { scrollLeft, scrollTop } = view;
    const step = Math.max(80, view.clientHeight * 0.2);
    if (button === GamepadButton.DIR_UP)
      pan(view.scrollLeft, view.scrollTop - step);
    if (button === GamepadButton.DIR_DOWN)
      pan(view.scrollLeft, view.scrollTop + step);
    if (button === GamepadButton.DIR_LEFT)
      pan(view.scrollLeft - step, view.scrollTop);
    if (button === GamepadButton.DIR_RIGHT)
      pan(view.scrollLeft + step, view.scrollTop);
    return view.scrollLeft !== scrollLeft || view.scrollTop !== scrollTop;
  };
  return (
    <Focusable
      className={`DialogContent _DialogLayout ${gamepadDialogClasses.GamepadDialogContent} grip-image-viewer`}
      role="dialog"
      aria-modal="true"
      aria-label="图片全屏查看"
      flow-children="column"
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
          if (event.detail.is_repeat) return true;
          if (button === GamepadButton.BUMPER_LEFT) zoom(1 / 1.5);
          else if (button === GamepadButton.BUMPER_RIGHT) zoom(1.5);
          else switchImage(button === GamepadButton.TRIGGER_LEFT ? -1 : 1);
          return true;
        }
        return false;
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (
          ["Escape", "+", "=", "-", "0", "PageUp", "PageDown"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          if (event.key === "Escape") onClose();
          else if (event.key === "0") fit();
          else if (event.key === "PageUp" || event.key === "PageDown")
            switchImage(event.key === "PageUp" ? -1 : 1);
          else zoom(event.key === "-" ? 1 / 1.5 : 1.5);
        } else if (
          keyboardDirections[event.key] !== undefined &&
          viewport.current?.contains(event.target as Node) &&
          direction(keyboardDirections[event.key])
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      style={{
        position: "fixed",
        inset: "40px 0 0",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        padding: "0 0 56px",
      }}
    >
      <Focusable
        ref={viewport}
        className="grip-image-viewport"
        tabIndex={0}
        focusable
        preferredFocus
        flow-children="none"
        aria-label="图片移动区域"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 PageUp PageDown Escape"
        data-dragging={dragging}
        onGamepadDirection={(event) => direction(event.detail.button)}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          const view = event.currentTarget;
          view.focus({ preventScroll: true });
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: view.scrollLeft,
            top: view.scrollTop,
          };
          setDragging(true);
          view.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          pan(
            start.left + start.x - event.clientX,
            start.top + start.y - event.clientY,
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) endDrag();
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) endDrag();
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) endDrag();
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          touchAction: "none",
          cursor: dragging ? "grabbing" : "grab",
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
      {failed && (
        <div role="alert">
          <DialogBodyText>图片暂不可用，请返回正文重试。</DialogBodyText>
        </div>
      )}
      <Focusable
        className="grip-image-toolbar"
        flow-children="row"
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
            <DialogButton
              className="grip-image-control"
              style={{ minWidth: 0, width: "auto" }}
              onClick={() => switchImage(-1)}
              disabled={index <= 0}
            >
              上一张
            </DialogButton>
            <span aria-live="polite" aria-atomic="true">
              {index + 1} / {choices.length}
            </span>
            <DialogButton
              className="grip-image-control"
              style={{ minWidth: 0, width: "auto" }}
              onClick={() => switchImage(1)}
              disabled={index >= choices.length - 1}
            >
              下一张
            </DialogButton>
          </>
        )}
        <DialogButton
          className="grip-image-control"
          style={{ minWidth: 0, width: "auto" }}
          onClick={() => zoom(1 / 1.5)}
          disabled={scale <= 0.01}
        >
          缩小
        </DialogButton>
        <span aria-live="polite" aria-atomic="true">
          {Math.round(scale * 100)}%
        </span>
        <DialogButton
          className="grip-image-control"
          style={{ minWidth: 0, width: "auto" }}
          onClick={() => zoom(1.5)}
          disabled={scale >= 8}
        >
          放大
        </DialogButton>
        <DialogButton
          className="grip-image-control"
          style={{ minWidth: 0, width: "auto" }}
          onClick={() => fit()}
        >
          适应屏幕
        </DialogButton>
        <DialogButton
          className="grip-image-control"
          style={{ minWidth: 0, width: "auto" }}
          onClick={onClose}
        >
          返回正文
        </DialogButton>
      </Focusable>
      <div
        title="键盘：方向键移动，+ / - 缩放，0 适屏，PageUp / PageDown 切图，Esc 返回"
        style={{
          textAlign: "center",
          paddingBottom: 8,
        }}
      >
        <DialogBodyText>
          方向键移动 · L1 / R1 缩放{choices.length > 1 ? " · L2 / R2 切图" : ""}{" "}
          · X 适屏 · B 返回
        </DialogBodyText>
      </div>
    </Focusable>
  );
}
