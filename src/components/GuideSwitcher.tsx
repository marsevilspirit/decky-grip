import {
  ConfirmModal,
  DialogBody,
  DialogBodyText,
  DialogButton,
  DialogHeader,
  Field as SteamField,
  Marquee,
  ModalRoot,
  ScrollPanel as SteamScrollPanel,
  SimpleModal,
  type FieldProps,
  type FocusableProps,
} from "@decky/ui";
import { useRef, useState, type FC, type MouseEventHandler } from "react";

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

// The original Steam Field forwards these navigation/DOM props; Decky's declaration omits them.
const Field = SteamField as FC<
  FieldProps & {
    role: "button";
    tabIndex: number;
    preferredFocus?: boolean;
    onContextMenu?: MouseEventHandler<HTMLDivElement>;
  }
>;
const ScrollPanel = SteamScrollPanel as FC<
  FocusableProps & { scrollDirection: "y" }
>;

function titleFor(entry: GuideLibraryEntry): string {
  return (
    entry.cache?.title ||
    `${isHeyboxGuideId(entry.guideId) ? "小黑盒" : "Steam"} 指南 ${entry.guideId}`
  );
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

  const closeSwitcher = () => {
    if (!confirming && !removalInFlight.current) onClose();
  };
  const closeManagement = () => {
    if (!removalInFlight.current) setRemoveMode(null);
  };

  const openManagement = (
    entry: GuideLibraryEntry,
    focusTarget?: HTMLElement,
  ) => {
    if (removalInFlight.current || confirming || pendingKey !== null) return;
    focusTarget?.focus({ preventScroll: true });
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
    <SimpleModal active>
      <ModalRoot
        aria-label="切换指南"
        className="grip-reader-guide-switcher"
        closeModal={closeSwitcher}
        onCancel={closeSwitcher}
      >
        <DialogHeader>本游戏指南</DialogHeader>
        <DialogBody>
          <ScrollPanel
            scrollDirection="y"
            data-grip-guide-list="true"
            flow-children="column"
            onCancel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!event.detail?.is_repeat) closeSwitcher();
            }}
            onCancelActionDescription="返回阅读"
            onOptionsButton={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            style={{
              maxHeight: "65vh",
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
                <Field
                  key={key}
                  role="button"
                  tabIndex={0}
                  highlightOnFocus
                  focusable
                  disabled={!current && pendingKey !== null}
                  data-grip-guide-row={key}
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openManagement(entry, event.currentTarget);
                  }}
                  onClick={() => {
                    // Field's disabled prop only styles the row; both native A and clicks reach here.
                    if (removalInFlight.current || confirming) return;
                    if (current) {
                      onClose();
                      return;
                    }
                    if (pendingKey !== null) return;
                    setChosenKey(key);
                    onChoose(entry);
                  }}
                  label={
                    <Marquee>
                      {current ? "正在阅读 · " : ""}
                      {titleFor(entry)}
                    </Marquee>
                  }
                  description={
                    <>
                      {entry.cache?.author && (
                        <div>
                          {isHeyboxGuideId(entry.guideId) ? "小黑盒 · " : ""}
                          作者：
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
                    </>
                  }
                />
              );
            })}
          </ScrollPanel>
        </DialogBody>
      </ModalRoot>
      <SimpleModal active={confirming}>
        {removeTarget ? (
          <ConfirmModal
            // These verified Steam runtime props are missing from Decky's declaration.
            {...{ bCloseAfterOK: false, focusButton: "secondary" }}
            bDestructiveWarning
            bDisableBackgroundDismiss
            bHideCloseIcon={removeMode === "busy"}
            bOKDisabled={removeMode === "busy" || cannotRemove}
            bCancelDisabled={removeMode === "busy"}
            closeModal={closeManagement}
            onCancel={closeManagement}
            onOK={remove}
            strTitle={`管理指南：${titleFor(removeTarget)}`}
            strOKButtonText={
              removeMode === "busy" ? (
                <BusyLabel>正在卸载…</BusyLabel>
              ) : cleanupOnly ? (
                "确认清理残留"
              ) : (
                "确认卸载"
              )
            }
            strCancelButtonText="取消"
            strDescription={
              <>
                <DialogBodyText>
                  来源：
                  {isHeyboxGuideId(removeTarget.guideId) ? "小黑盒" : "Steam"}
                </DialogBodyText>
                {removeTarget.cache?.author && (
                  <DialogBodyText>
                    作者：{removeTarget.cache.author}
                  </DialogBodyText>
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
                    <DialogBodyText>
                      请等待下载或更新完成后再卸载。
                    </DialogBodyText>
                  </div>
                )}
                {removeError && (
                  <div role="alert">
                    <DialogBodyText>{removeError}</DialogBodyText>
                  </div>
                )}
              </>
            }
          />
        ) : (
          <></>
        )}
      </SimpleModal>
    </SimpleModal>
  );
}
