import { Button, DropdownItem, ModalRoot, TextField } from "@decky/ui";
import { useRef, useState, useSyncExternalStore } from "react";

import { parseHeyboxUrl } from "../import/heybox";
import type { GuideDownloadTasks } from "../reader/download";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import { BusyLabel } from "./BusyLabel";
import { PhoneImport } from "./PhoneImport";

export interface ImportGame {
  data: string;
  label: string;
}

export function ImportGuideModal({
  games,
  downloads,
  onOpen,
  closeModal,
}: {
  games: ImportGame[];
  downloads: GuideDownloadTasks;
  onOpen: (identity: GuideIdentity) => Promise<void>;
  closeModal?: () => void;
}) {
  const [text, setText] = useState("");
  const [appId, setAppId] = useState(games[0]?.data ?? "");
  const [identity, setIdentity] = useState<GuideIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  const task = useSyncExternalStore(downloads.subscribe, () =>
    identity ? downloads.getSnapshot(identity.guideId) : null,
  );
  const busy = task?.phase === "downloading" || task?.phase === "canceling";
  const resetFeedback = () => {
    setIdentity(null);
    setError(null);
  };
  const changeLink = (link: string) => {
    if (starting.current || busy) return;
    setText(link);
    resetFeedback();
  };
  const start = () => {
    if (starting.current || busy) return;
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
      setIdentity(next);
      setError(null);
      starting.current = true;
      void downloads.start(next, true).finally(() => {
        starting.current = false;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div
        style={{
          padding: 24,
          maxWidth: 680,
          maxHeight: "70vh",
          overflowY: "auto",
        }}
      >
        <h2>导入小黑盒攻略</h2>
        <p>
          粘贴公开文章的分享链接或分享文字，确认所属游戏后保存。无需登录小黑盒。
        </p>
        <TextField
          label="分享链接"
          value={text}
          disabled={busy}
          onChange={(event) => changeLink(event.target.value)}
        />
        <PhoneImport disabled={busy} onLink={changeLink} />
        {games.length ? (
          <DropdownItem
            label="保存到游戏"
            selectedOption={appId}
            rgOptions={games}
            disabled={busy}
            onChange={(option) => {
              setAppId(String(option.data));
              resetFeedback();
            }}
          />
        ) : (
          <p role="alert">请先在 Steam 中打开目标游戏的库页面，再来导入。</p>
        )}
        <p style={{ opacity: 0.75 }}>
          导入时临时加载网页，正文和全部图片保存后才算完成。关闭此窗口不取消下载。
        </p>
        <div role="status" aria-live="polite">
          {busy && (
            <BusyLabel>
              {task.phase === "canceling"
                ? "正在取消…"
                : !task.progress
                  ? "正在渲染文章、收集完整图片…"
                  : task.progress.publishing
                    ? "正在保存完整离线版本…"
                    : `正在下载图片 ${task.progress.completed}/${task.progress.total}`}
            </BusyLabel>
          )}
          {task?.phase === "complete" &&
            "正文和图片已完整保存。在游戏内按 Y 即可切换到这篇攻略。"}
          {task?.phase === "canceled" && "已取消，原有离线版本保留。"}
        </div>
        {(error || task?.error) && <p role="alert">{error || task?.error}</p>}
        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <Button disabled={busy || !appId || !text.trim()} onClick={start}>
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
              onClick={() => {
                void onOpen(identity)
                  .then(() => closeModal?.())
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  );
              }}
            >
              立即阅读
            </Button>
          )}
          <Button onClick={closeModal}>关闭</Button>
        </div>
      </div>
    </ModalRoot>
  );
}
