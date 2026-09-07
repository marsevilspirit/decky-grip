import { Button, Focusable, GamepadButton, type GamepadEvent } from "@decky/ui";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { CacheClearResult, GuideLibraryEntry } from "../backend";
import { makeGuideKey } from "../steam/guide-key";
import { BusyLabel } from "./BusyLabel";

export interface GuideSwitcherProps {
  entries: GuideLibraryEntry[] | null;
  currentGuideId: string;
  pendingKey: string | null;
  error: string | null;
  removed: boolean;
  removeDisabled: boolean;
  onChoose: (entry: GuideLibraryEntry) => void;
  onReload: () => void;
  onClose: () => void;
  onRemove: () => Promise<CacheClearResult>;
}

const SWITCHER_CSS = `
.grip-reader-guide-switcher .grip-guide-choice {
  box-sizing: border-box; width: 100%; min-height: 100px; margin-bottom: 12px;
  padding: 14px 18px; text-align: left; white-space: normal; overflow-wrap: anywhere;
  color: #dcdedf; background: #1d2b38; border: 2px solid transparent; border-radius: 8px;
}
.grip-reader-guide-switcher .grip-guide-choice[data-current="true"] { border-color: #406078; }
.grip-reader-guide-switcher .grip-guide-choice:focus, .grip-reader-guide-switcher .grip-guide-choice[data-focused="true"] {
  color: #fff; background: #29475f; border-color: #89d3ff;
  box-shadow: 0 0 0 2px #89d3ff55;
}
.grip-reader-guide-switcher .grip-guide-choice:active, .grip-reader-guide-switcher .grip-guide-choice[data-pressed="true"] { background: #365e7a; }
.grip-guide-choice-status { font-size: 13px; line-height: 1.5; margin-top: 7px; color: #a9d9f4; }
.grip-guide-choice [role="alert"] { color: #ffc4b8; }
@keyframes grip-switcher-enter { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: no-preference) {
  .grip-reader-guide-switcher { animation: grip-switcher-enter 120ms ease-out; }
  .grip-reader-guide-switcher .grip-guide-choice { transition: background 100ms ease-out, border-color 100ms ease-out, box-shadow 100ms ease-out, transform 80ms ease-out; }
  .grip-reader-guide-switcher .grip-guide-choice:focus, .grip-reader-guide-switcher .grip-guide-choice[data-focused="true"] { transform: translateX(3px); }
  .grip-reader-guide-switcher .grip-guide-choice:active, .grip-reader-guide-switcher .grip-guide-choice[data-pressed="true"] { transform: scale(0.99); }
}
@media (prefers-reduced-motion: reduce) {
  .grip-reader-guide-switcher, .grip-reader-guide-switcher .grip-guide-choice { animation: none; transition: none; transform: none; }
}
`;

function titleFor(entry: GuideLibraryEntry): string {
  return entry.cache?.title || `Steam 指南 ${entry.guideId}`;
}

export function GuideSwitcher({
  entries,
  currentGuideId,
  pendingKey,
  error,
  removed,
  removeDisabled,
  onChoose,
  onReload,
  onClose,
  onRemove,
}: GuideSwitcherProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const removalInFlight = useRef(false);
  const [removeMode, setRemoveMode] = useState<"confirm" | "busy" | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeResult, setRemoveResult] = useState<CacheClearResult | null>(
    null,
  );
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const confirming = removeMode !== null;
  const removedHere = removed || removeResult !== null;
  const cannotRemove = removedHere || removeDisabled || pendingKey !== null;
  const failedKey = error && pendingKey === null ? chosenKey : null;
  const failedEntry = entries?.find(
    (entry) => makeGuideKey(entry) === failedKey,
  );
  const currentEntry = entries?.find(
    (entry) => entry.guideId === currentGuideId,
  );
  const preferredEntry =
    entries?.find((entry) => entry.guideId !== currentGuideId) ?? entries?.[0];

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const active = dialog.ownerDocument.activeElement;
      if (confirming) {
        if (
          !active ||
          !dialog.querySelector('[role="alertdialog"]')?.contains(active)
        )
          cancelRef.current?.focus({ preventScroll: true });
        return;
      }
      if (
        active &&
        active !== dialog &&
        dialog.contains(active) &&
        !active.closest("[hidden]")
      )
        return;
      const previous = returnFocusRef.current;
      returnFocusRef.current = null;
      const target =
        previous?.isConnected && dialog.contains(previous)
          ? previous
          : (dialog.querySelector<HTMLElement>(
              '[data-grip-guide-choice]:not([data-current="true"])',
            ) ??
            dialog.querySelector<HTMLElement>(
              "[data-grip-guide-choice], [data-grip-guide-list-retry]",
            ) ??
            dialog);
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, error, confirming]);

  const cancel = (event: CustomEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      (event as GamepadEvent).detail?.is_repeat ||
      ("repeat" in event && event.repeat)
    )
      return;
    if (removalInFlight.current) return;
    if (confirming) setRemoveMode(null);
    else onClose();
  };

  const remove = async () => {
    if (removeMode !== "confirm" || cannotRemove || removalInFlight.current)
      return;
    removalInFlight.current = true;
    setRemoveMode("busy");
    setRemoveError(null);
    try {
      setRemoveResult(await onRemove());
      setRemoveMode(null);
    } catch (reason: unknown) {
      setRemoveError(
        `删除失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
      setRemoveMode("confirm");
    } finally {
      removalInFlight.current = false;
    }
  };

  return (
    <Focusable
      ref={dialogRef}
      role="dialog"
      aria-label="切换指南"
      aria-modal="true"
      className="grip-reader-guide-switcher"
      tabIndex={0}
      onCancel={cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel(event);
        } else if (event.key === "Tab") {
          const dialog = dialogRef.current;
          if (!dialog) return;
          const targets = [
            ...dialog.querySelectorAll<HTMLElement>(
              "button, [role='button'], [tabindex]",
            ),
          ].filter(
            (node) =>
              !node.closest("[hidden], [inert]") &&
              !node.matches(":disabled, [tabindex='-1']"),
          );
          const focused = targets.indexOf(
            dialog.ownerDocument.activeElement as HTMLElement,
          );
          const next =
            focused < 0
              ? event.shiftKey
                ? targets.length - 1
                : 0
              : (focused + (event.shiftKey ? -1 : 1) + targets.length) %
                targets.length;
          event.preventDefault();
          event.stopPropagation();
          (targets[next] ?? dialog).focus({ preventScroll: true });
        }
      }}
      onCancelActionDescription={confirming ? "取消删除" : "返回阅读"}
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        background: "linear-gradient(180deg, #16202b 0%, #0d141c 100%)",
        position: "absolute",
        top: 40,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        padding: "20px 28px 56px",
        overflow: "hidden",
      }}
    >
      <style>{SWITCHER_CSS}</style>
      <h2 style={{ fontSize: 24, margin: "0 0 16px", flexShrink: 0 }}>
        本游戏指南
      </h2>
      <div
        hidden={confirming}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 6px 8px",
        }}
      >
        {entries === null && !error && (
          <div role="status">
            <BusyLabel>正在读取本游戏指南…</BusyLabel>
          </div>
        )}
        {error && !failedEntry && (
          <div role="alert" style={{ color: "#ffc4b8", marginBottom: 12 }}>
            <p>{error}</p>
            <Button
              data-grip-guide-list-retry="true"
              aria-disabled={pendingKey !== null}
              onClick={() => {
                if (pendingKey !== null) return;
                setChosenKey(null);
                onReload();
              }}
            >
              重新读取指南列表
            </Button>
          </div>
        )}
        {entries?.length === 0 && !error && <p>本游戏还没有已记录的指南。</p>}
        {entries?.map((entry) => {
          const key = makeGuideKey(entry);
          const current = entry.guideId === currentGuideId;
          const pending = pendingKey === key;
          const failed = failedEntry === entry;
          return (
            <Button
              key={key}
              className="grip-guide-choice"
              data-grip-guide-choice={key}
              data-current={current ? "true" : undefined}
              data-focused={focusedKey === key ? "true" : undefined}
              data-pressed={pressedKey === key ? "true" : undefined}
              aria-current={current ? "page" : undefined}
              aria-busy={pending}
              aria-disabled={!current && pendingKey !== null}
              aria-label={`${current ? "返回阅读" : "打开指南"}：${titleFor(entry)}`}
              preferredFocus={entry === preferredEntry}
              onOKActionDescription={
                current ? "返回阅读" : failed ? "重试打开" : "打开指南"
              }
              onGamepadFocus={() => setFocusedKey(key)}
              onGamepadBlur={() => {
                setFocusedKey((value) => (value === key ? null : value));
                setPressedKey((value) => (value === key ? null : value));
              }}
              onButtonDown={(event) => {
                if (event.detail.button === GamepadButton.OK)
                  setPressedKey(key);
              }}
              onButtonUp={(event) => {
                if (event.detail.button === GamepadButton.OK)
                  setPressedKey(null);
              }}
              onClick={() => {
                if (removalInFlight.current || confirming) return;
                if (current) {
                  onClose();
                  return;
                }
                if (pendingKey !== null) return;
                setChosenKey(key);
                onChoose(entry);
              }}
            >
              <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.4 }}>
                {current ? "正在阅读 · " : ""}
                {titleFor(entry)}
              </div>
              {entry.cache?.author && (
                <div style={{ fontSize: 14, marginTop: 5, opacity: 0.8 }}>
                  作者：{entry.cache.author}
                </div>
              )}
              {entry.cache?.sectionTitle && (
                <div style={{ fontSize: 14, marginTop: 4, opacity: 0.8 }}>
                  上次：{entry.cache.sectionTitle}
                </div>
              )}
              <div className="grip-guide-choice-status">
                {pending ? (
                  <BusyLabel>正在准备并打开…</BusyLabel>
                ) : failed ? (
                  <span role="alert">{error} · 按 A 重试打开</span>
                ) : current && removedHere ? (
                  "离线副本已删除，当前会话仍可阅读"
                ) : current ? (
                  "按 A 返回当前阅读位置"
                ) : entry.cache ? (
                  entry.cache.stale ? (
                    "已缓存正文，可继续阅读"
                  ) : (
                    "已缓存正文"
                  )
                ) : (
                  "首次打开将下载正文"
                )}
              </div>
            </Button>
          );
        })}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label="确认删除离线副本"
          aria-busy={removeMode === "busy"}
          style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        >
          <p>
            删除《
            {currentEntry
              ? titleFor(currentEntry)
              : `Steam 指南 ${currentGuideId}`}
            》的正文和独有图片？阅读位置及其他指南共用的图片会保留。
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <Button
              ref={cancelRef}
              preferredFocus
              aria-disabled={removeMode === "busy"}
              onClick={() => {
                if (!removalInFlight.current) setRemoveMode(null);
              }}
            >
              取消
            </Button>
            <Button
              aria-disabled={removeMode === "busy" || cannotRemove}
              onClick={() => void remove()}
            >
              {removeMode === "busy" ? (
                <BusyLabel>正在删除…</BusyLabel>
              ) : (
                "确认删除"
              )}
            </Button>
          </div>
          {removeError && (
            <p role="alert" style={{ color: "#ffc4b8" }}>
              {removeError}
            </p>
          )}
        </div>
      )}
      <div hidden={confirming} style={{ flexShrink: 0, paddingTop: 8 }}>
        <Button
          aria-disabled={cannotRemove}
          onClick={() => {
            if (cannotRemove) return;
            const active = dialogRef.current?.ownerDocument.activeElement;
            returnFocusRef.current =
              active instanceof HTMLElement ? active : null;
            setRemoveError(null);
            setRemoveMode("confirm");
          }}
        >
          删除当前指南离线副本
        </Button>
        {removedHere && (
          <p role="status" style={{ fontSize: 13, margin: "8px 0 0" }}>
            离线副本已删除
            {removeResult
              ? `，释放 ${(removeResult.bytesRemoved / 1024 / 1024).toFixed(1)} MiB`
              : ""}
            。阅读位置和共用图片已保留。
          </p>
        )}
      </div>
    </Focusable>
  );
}
