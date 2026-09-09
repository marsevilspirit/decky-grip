import {
  DialogBodyText,
  DialogButton,
  DialogHeader,
  Focusable,
  gamepadDialogClasses,
  type GamepadEvent,
} from "@decky/ui";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { CacheClearResult, GuideLibraryEntry } from "../backend";
import { isHeyboxGuideId, makeGuideKey } from "../steam/guide-key";
import { BusyLabel } from "./BusyLabel";

export interface GuideSwitcherProps {
  entries: GuideLibraryEntry[] | null;
  currentGuideId: string;
  pendingKey: string | null;
  listError: string | null;
  error: string | null;
  removed: boolean;
  removeDisabled: boolean;
  onChoose: (entry: GuideLibraryEntry) => void;
  onReload: () => void;
  onClose: () => void;
  onRemove: (entry: GuideLibraryEntry) => Promise<CacheClearResult>;
}

const SWITCHER_CSS = `
.grip-guide-row { display: flex; margin-bottom: 12px; }
.grip-reader-guide-switcher .grip-guide-choice {
  flex: 1; min-width: 0; height: auto;
  text-align: left; white-space: normal; overflow-wrap: anywhere;
}
`;

function titleFor(entry: GuideLibraryEntry): string {
  return (
    entry.cache?.title ||
    `${isHeyboxGuideId(entry.guideId) ? "小黑盒" : "Steam"} 指南 ${entry.guideId}`
  );
}

function revealChoice(target: HTMLElement | null) {
  target?.closest("[data-grip-guide-row]")?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "auto",
  });
}

export function GuideSwitcher({
  entries,
  currentGuideId,
  pendingKey,
  listError,
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
  const [removeTarget, setRemoveTarget] = useState<GuideLibraryEntry | null>(
    null,
  );
  const [removeMode, setRemoveMode] = useState<"confirm" | "busy" | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeResults, setRemoveResults] = useState<
    Record<string, CacheClearResult>
  >({});
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const confirming = removeMode !== null;
  const removedEntry = (entry: GuideLibraryEntry) =>
    (removed && entry.guideId === currentGuideId) ||
    !!removeResults[entry.guideId];
  const targetInLibrary =
    removeTarget &&
    entries?.find(
      (entry) => makeGuideKey(entry) === makeGuideKey(removeTarget),
    );
  const cannotRemove =
    !targetInLibrary ||
    (removeTarget !== null && removedEntry(removeTarget)) ||
    removeDisabled ||
    pendingKey !== null;
  // The body can already be gone after partial cleanup. The backend safely retries image reclamation.
  const cleanupOnly = !targetInLibrary?.cache;
  const failedKey = error && pendingKey === null ? chosenKey : null;
  const failedEntry = entries?.find(
    (entry) => makeGuideKey(entry) === failedKey,
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
  }, [entries, listError, error, confirming]);

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

  const openManagement = (entry: GuideLibraryEntry) => {
    if (removalInFlight.current || confirming || pendingKey !== null) return;
    const active = dialogRef.current?.ownerDocument.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    setRemoveTarget(entry);
    setRemoveError(null);
    setRemoveMode("confirm");
  };

  const remove = async () => {
    if (
      !removeTarget ||
      removeMode !== "confirm" ||
      cannotRemove ||
      removalInFlight.current
    )
      return;
    removalInFlight.current = true;
    setRemoveMode("busy");
    setRemoveError(null);
    try {
      const result = await onRemove(removeTarget);
      setRemoveResults((results) => ({
        ...results,
        [removeTarget.guideId]: result,
      }));
      setRemoveMode(null);
    } catch (reason: unknown) {
      setRemoveError(
        `卸载失败：${reason instanceof Error ? reason.message : String(reason)}`,
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
      className={`grip-reader-guide-switcher DialogContent _DialogLayout ${gamepadDialogClasses.GamepadDialogContent}`}
      tabIndex={0}
      onCancel={cancel}
      onFocusCapture={(event) => revealChoice(event.target as HTMLElement)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel(event);
        } else if (
          !confirming &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.key.toLowerCase() === "x"
        ) {
          const row = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-grip-guide-row]",
          );
          const entry = entries?.find(
            (entry) => makeGuideKey(entry) === row?.dataset.gripGuideRow,
          );
          if (!entry) return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) openManagement(entry);
        } else if (
          !confirming &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
        ) {
          const target = (event.target as HTMLElement)
            .closest<HTMLElement>("[data-grip-guide-row]")
            ?.querySelector<HTMLElement>("[data-grip-guide-choice]");
          if (!target) return;
          const choices = [
            ...(dialogRef.current?.querySelectorAll<HTMLElement>(
              "[data-grip-guide-choice]",
            ) ?? []),
          ];
          const focused = choices.indexOf(target);
          if (focused < 0) return;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? choices.length - 1
                : focused + (event.key === "ArrowDown" ? 1 : -1);
          event.preventDefault();
          event.stopPropagation();
          choices[Math.max(0, Math.min(choices.length - 1, next))].focus({
            preventScroll: true,
          });
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
      onCancelActionDescription={confirming ? "取消卸载" : "返回阅读"}
      onSecondaryButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onOptionsButton={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
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
      <DialogHeader style={{ flexShrink: 0 }}>本游戏指南</DialogHeader>
      <div
        data-grip-guide-list="true"
        hidden={confirming}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 6px 8px",
        }}
      >
        {entries === null && !listError && !error && (
          <div role="status">
            <BusyLabel>正在读取本游戏指南…</BusyLabel>
          </div>
        )}
        {listError && (
          <div role="alert" style={{ marginBottom: 12 }}>
            <DialogBodyText>{listError}</DialogBodyText>
            <DialogButton
              data-grip-guide-list-retry="true"
              disabled={pendingKey !== null}
              focusable
              aria-disabled={pendingKey !== null}
              onClick={() => {
                if (pendingKey !== null) return;
                onReload();
              }}
            >
              重新读取指南列表
            </DialogButton>
          </div>
        )}
        {error && !failedEntry && (
          <div role="alert">
            <DialogBodyText>{error}</DialogBodyText>
          </div>
        )}
        {entries?.length === 0 && !listError && !error && (
          <DialogBodyText>本游戏还没有已记录的指南。</DialogBodyText>
        )}
        {entries?.map((entry) => {
          const key = makeGuideKey(entry);
          const current = entry.guideId === currentGuideId;
          const pending = pendingKey === key;
          const failed = failedEntry === entry;
          const result = removeResults[entry.guideId];
          return (
            <div key={key} className="grip-guide-row" data-grip-guide-row={key}>
              <DialogButton
                className="grip-guide-choice"
                disabled={!current && pendingKey !== null}
                focusable
                data-grip-guide-choice={key}
                data-current={current ? "true" : undefined}
                aria-current={current ? "page" : undefined}
                aria-busy={pending}
                aria-disabled={!current && pendingKey !== null}
                aria-label={`${current ? "返回阅读" : "打开指南"}：${titleFor(entry)}`}
                preferredFocus={entry === preferredEntry}
                onOKActionDescription={
                  current
                    ? "返回阅读"
                    : pendingKey !== null
                      ? null
                      : failed
                        ? "重试打开"
                        : "打开指南"
                }
                onSecondaryActionDescription={
                  pendingKey === null ? "管理指南" : null
                }
                onSecondaryButton={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.detail.is_repeat) openManagement(entry);
                }}
                onGamepadFocus={(event) => {
                  revealChoice(event.target as HTMLElement);
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
                <div style={{ minWidth: 0, width: "100%" }}>
                  <div>
                    {current ? "正在阅读 · " : ""}
                    {titleFor(entry)}
                  </div>
                  {entry.cache?.author && (
                    <div>
                      {isHeyboxGuideId(entry.guideId) ? "小黑盒 · " : ""}作者：
                      {entry.cache.author}
                    </div>
                  )}
                  {entry.cache?.sectionTitle && (
                    <div>上次：{entry.cache.sectionTitle}</div>
                  )}
                  <div>
                    {pending ? (
                      <BusyLabel>正在准备并打开…</BusyLabel>
                    ) : failed ? (
                      <span role="alert">{error} · 按 A 重试打开</span>
                    ) : removedEntry(entry) ? (
                      `离线副本已卸载${result ? `，释放 ${(result.bytesRemoved / 1024 / 1024).toFixed(1)} MiB` : ""}${current ? "，当前会话仍可阅读" : "，阅读位置已保留"}`
                    ) : current ? (
                      "按 A 返回当前阅读位置"
                    ) : entry.cache ? (
                      entry.cache.stale ? (
                        "已缓存正文，可继续阅读"
                      ) : (
                        "已缓存正文"
                      )
                    ) : (
                      "未下载离线副本，打开时将下载正文"
                    )}
                  </div>
                </div>
              </DialogButton>
            </div>
          );
        })}
      </div>
      {confirming && removeTarget && (
        <div
          role="alertdialog"
          aria-label={`管理指南：${titleFor(removeTarget)}`}
          aria-busy={removeMode === "busy"}
          style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        >
          <DialogHeader>{titleFor(removeTarget)}</DialogHeader>
          <DialogBodyText>
            来源：{isHeyboxGuideId(removeTarget.guideId) ? "小黑盒" : "Steam"}
          </DialogBodyText>
          {removeTarget.cache?.author && (
            <DialogBodyText>作者：{removeTarget.cache.author}</DialogBodyText>
          )}
          <DialogBodyText>
            {cleanupOnly
              ? "正文未缓存，是否清理未完成卸载留下的图片？"
              : "卸载这篇指南的正文和独有图片？"}
            阅读位置及其他指南共用的图片会保留。同一篇指南在其他游戏中的离线副本也会卸载。
          </DialogBodyText>
          {(!targetInLibrary?.cache || removedEntry(removeTarget)) && (
            <div role="status">
              <DialogBodyText>
                {removedEntry(removeTarget)
                  ? "这篇指南的离线副本已卸载。"
                  : "可重试完成剩余离线文件的清理。"}
              </DialogBodyText>
            </div>
          )}
          {removeDisabled && (
            <div role="status">
              <DialogBodyText>请等待下载或更新完成后再卸载。</DialogBodyText>
            </div>
          )}
          <div style={{ display: "flex", gap: 12 }}>
            <DialogButton
              ref={cancelRef}
              preferredFocus
              disabled={removeMode === "busy"}
              focusable
              aria-disabled={removeMode === "busy"}
              onClick={() => {
                if (!removalInFlight.current) setRemoveMode(null);
              }}
            >
              取消
            </DialogButton>
            <DialogButton
              disabled={removeMode === "busy" || cannotRemove}
              focusable
              aria-disabled={removeMode === "busy" || cannotRemove}
              onClick={() => void remove()}
            >
              {removeMode === "busy" ? (
                <BusyLabel>正在卸载…</BusyLabel>
              ) : cleanupOnly ? (
                "确认清理残留"
              ) : (
                "确认卸载"
              )}
            </DialogButton>
          </div>
          {removeError && (
            <div role="alert">
              <DialogBodyText>{removeError}</DialogBodyText>
            </div>
          )}
        </div>
      )}
    </Focusable>
  );
}
