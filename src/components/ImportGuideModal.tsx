import {
  DialogButton as Button,
  DialogBody,
  DialogBodyText,
  DialogControlsSection,
  DialogFooter,
  DialogHeader,
  DropdownItem,
  ModalRoot,
  ProgressBar,
  TextField,
} from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { parseHeyboxUrl } from "../import/heybox";
import type { GuideDownloadTasks } from "../reader/download";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import { BusyLabel } from "./BusyLabel";
import { PhoneImport } from "./PhoneImport";

export interface ImportGame {
  data: string;
  label: string;
}

export interface ImportGuideDraft {
  text: string;
  game: ImportGame | null;
  identity: GuideIdentity | null;
}

export function ImportGuideModal({
  games,
  downloads,
  initialDraft,
  onDraftChange,
  onOpen,
  closeModal,
}: {
  games: ImportGame[];
  downloads: GuideDownloadTasks;
  initialDraft?: ImportGuideDraft;
  onDraftChange?: (draft: ImportGuideDraft) => void;
  onOpen: (identity: GuideIdentity) => Promise<void>;
  closeModal?: () => void;
}) {
  const [draft, setDraft] = useState<ImportGuideDraft>(() => ({
    text: initialDraft?.text ?? "",
    game: initialDraft?.game ?? games[0] ?? null,
    identity: initialDraft?.identity ?? null,
  }));
  const draftRef = useRef(draft);
  const { text, game, identity } = draft;
  const appId = game?.data ?? "";
  const gameOptions =
    game && !games.some((candidate) => candidate.data === game.data)
      ? [game, ...games]
      : games;
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  const openingRef = useRef(false);
  const starting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const task = useSyncExternalStore(downloads.subscribe, () =>
    identity ? downloads.getSnapshot(identity.guideId) : null,
  );
  const busy = task?.phase === "downloading" || task?.phase === "canceling";
  const locked = busy || opening;
  const progress = task?.progress;
  const updateDraft = (change: Partial<ImportGuideDraft>) => {
    const next = { ...draftRef.current, ...change };
    draftRef.current = next;
    setDraft(next);
    // Save on edits, not on close: Steam may dismiss the modal through its native return path.
    onDraftChange?.(next);
    setError(null);
  };
  const changeLink = (link: string) => {
    if (starting.current || openingRef.current || busy) return;
    updateDraft({ text: link, identity: null });
  };
  const start = () => {
    if (starting.current || openingRef.current || busy) return;
    try {
      const parsed = parseHeyboxUrl(text);
      const next = { appId, guideId: parsed.guideId };
      makeGuideKey(next);
      const existing = downloads.getSnapshot(next.guideId);
      if (
        existing?.phase === "downloading" ||
        existing?.phase === "canceling"
      ) {
        throw new Error("这篇攻略正在后台导入，请等待完成后再为所选游戏导入");
      }
      updateDraft({ identity: next });
      starting.current = true;
      void downloads.start(next, true).finally(() => {
        starting.current = false;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const open = async () => {
    if (!identity || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      await onOpen(identity);
      if (mounted.current) closeModal?.();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  };
  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <DialogHeader>导入小黑盒攻略</DialogHeader>
      <DialogBody>
        <DialogBodyText>
          粘贴公开文章的分享链接或分享文字，确认所属游戏后保存。无需登录小黑盒。
        </DialogBodyText>
        <DialogControlsSection>
          <TextField
            label="分享链接"
            value={text}
            disabled={locked}
            onChange={(event) => changeLink(event.target.value)}
          />
          <PhoneImport disabled={locked} onLink={changeLink} />
          {gameOptions.length ? (
            <DropdownItem
              label="保存到游戏"
              selectedOption={appId}
              rgOptions={gameOptions}
              disabled={locked}
              onChange={(option) => {
                if (starting.current || openingRef.current || busy) return;
                const next = gameOptions.find(
                  (candidate) => candidate.data === String(option.data),
                );
                if (next) updateDraft({ game: next, identity: null });
              }}
            />
          ) : (
            <DialogBodyText>
              <div role="alert">
                请先在 Steam 中打开目标游戏的库页面，再来导入。
              </div>
            </DialogBodyText>
          )}
        </DialogControlsSection>
        <DialogBodyText>
          导入时临时加载网页，正文和全部图片保存后才算完成。关闭此窗口不取消下载。
        </DialogBodyText>
        <DialogBodyText>
          <div role="status" aria-live="polite">
            {busy && (
              <BusyLabel>
                {task.phase === "canceling"
                  ? "正在取消…"
                  : !progress
                    ? "正在渲染文章、收集完整图片…"
                    : progress.publishing
                      ? "正在保存完整离线版本…"
                      : progress.total === 0
                        ? "正文已就绪，无需下载图片…"
                        : `正在下载图片 ${progress.completed}/${progress.total}`}
              </BusyLabel>
            )}
            {task?.phase === "complete" &&
              "正文和图片已完整保存。在游戏内按 Y 即可切换到这篇攻略。"}
            {task?.phase === "canceled" && "已取消，原有离线版本保留。"}
          </div>
        </DialogBodyText>
        {task?.phase === "downloading" && progress && progress.total > 0 && (
          <div role="group" aria-label="图片下载进度">
            <ProgressBar
              nProgress={(progress.completed / progress.total) * 100}
              focusable={false}
            />
          </div>
        )}
        {(error || task?.error) && (
          <DialogBodyText>
            <div role="alert">{error || task?.error}</div>
          </DialogBodyText>
        )}
      </DialogBody>
      <DialogFooter>
        <Button disabled={locked || !appId || !text.trim()} onClick={start}>
          {task?.phase === "failed" ? "重试导入" : "保存完整图文"}
        </Button>
        {busy && (
          <Button
            disabled={task.phase === "canceling" || task.progress?.publishing}
            onClick={() => identity && downloads.cancel(identity.guideId)}
          >
            取消导入
          </Button>
        )}
        {task?.phase === "complete" && identity && (
          <Button
            disabled={opening}
            aria-busy={opening}
            onClick={() => void open()}
          >
            {opening ? <BusyLabel>正在打开…</BusyLabel> : "立即阅读"}
          </Button>
        )}
        <Button onClick={closeModal}>关闭</Button>
      </DialogFooter>
    </ModalRoot>
  );
}
