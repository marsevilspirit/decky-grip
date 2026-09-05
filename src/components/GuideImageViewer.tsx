import { Button, Focusable, GamepadButton, type GamepadEvent } from "@decky/ui";
import { useLayoutEffect, useRef, useState } from "react";

export interface ReaderPreviewImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export function GuideImageViewer({
  image,
  onClose,
}: {
  image: ReaderPreviewImage;
  onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const previousScale = useRef<number | null>(null);
  const fit = () => {
    const view = viewport.current;
    if (!view) return;
    const fitted = Math.min(
      1,
      Math.max(1, view.clientWidth - 32) / image.width,
      Math.max(1, view.clientHeight - 32) / image.height,
    );
    previousScale.current = fitted === scale ? scale : null;
    setScale(fitted);
    view.scrollTop = view.scrollLeft = 0;
  };
  const zoom = (factor: number) =>
    setScale((value) => Math.min(8, Math.max(0.01, value * factor)));
  useLayoutEffect(() => {
    fit();
    viewport.current?.focus({ preventScroll: true });
  }, [image.src]);
  useLayoutEffect(() => {
    const view = viewport.current;
    const old = previousScale.current;
    if (view && old !== null) {
      const centered = (scroll: number, size: number, pixels: number) =>
        Math.max(
          0,
          ((scroll + size / 2 - Math.max(0, size - pixels * old) / 2) * scale) /
            old +
            Math.max(0, size - pixels * scale) / 2 -
            size / 2,
        );
      view.scrollLeft = centered(
        view.scrollLeft,
        view.clientWidth,
        image.width,
      );
      view.scrollTop = centered(
        view.scrollTop,
        view.clientHeight,
        image.height,
      );
    }
    previousScale.current = scale;
  }, [scale]);
  const direction = (event: GamepadEvent) => {
    const view = viewport.current;
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(80, view.clientHeight * 0.2);
    if (event.detail.button === GamepadButton.DIR_UP) view.scrollTop -= step;
    if (event.detail.button === GamepadButton.DIR_DOWN) view.scrollTop += step;
    if (event.detail.button === GamepadButton.DIR_LEFT) view.scrollLeft -= step;
    if (event.detail.button === GamepadButton.DIR_RIGHT)
      view.scrollLeft += step;
  };
  return (
    <Focusable
      role="dialog"
      aria-modal="true"
      aria-label="图片全屏查看"
      onCancelActionDescription="返回正文"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onButtonDown={(event) => {
        if (event.detail.button === GamepadButton.BUMPER_RIGHT) {
          event.preventDefault();
          event.stopPropagation();
          zoom(1.5);
        } else if (event.detail.button === GamepadButton.BUMPER_LEFT) {
          event.preventDefault();
          event.stopPropagation();
          zoom(1 / 1.5);
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
      <Focusable
        ref={viewport}
        tabIndex={0}
        preferredFocus
        flow-children="none"
        aria-label="图片移动区域"
        onGamepadDirection={direction}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") zoom(1.5);
          else if (event.key === "-") zoom(1 / 1.5);
        }}
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
            width: image.width * scale,
            height: image.height * scale,
          }}
        >
          <img
            src={image.src}
            alt={image.alt || "指南图片"}
            draggable={false}
            onError={() => setFailed(true)}
            style={{
              display: "block",
              width: image.width * scale,
              height: image.height * scale,
              maxWidth: "none",
              flexShrink: 0,
            }}
          />
        </div>
      </Focusable>
      {failed && <div role="alert">图片暂不可用，请返回正文重试。</div>}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          justifyContent: "center",
        }}
      >
        <Button onClick={() => zoom(1 / 1.5)} disabled={scale <= 0.01}>
          缩小
        </Button>
        <span aria-live="polite">{Math.round(scale * 100)}%</span>
        <Button onClick={() => zoom(1.5)} disabled={scale >= 8}>
          放大
        </Button>
        <Button onClick={fit}>适应屏幕</Button>
        <Button onClick={onClose}>返回正文</Button>
        <span style={{ opacity: 0.7, fontSize: 14 }}>
          方向键移动 · L1 / R1 缩放
        </span>
      </div>
    </Focusable>
  );
}
