import { Button } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";

import {
  startPhoneImport,
  getPhoneImport,
  stopPhoneImport,
  type PhoneImportSession,
} from "../backend";
import { BusyLabel } from "./BusyLabel";

export function PhoneImport({
  disabled,
  onLink,
}: {
  disabled: boolean;
  onLink: (text: string) => void;
}) {
  const [session, setSession] = useState<PhoneImportSession | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const active = useRef<PhoneImportSession | null>(null);
  const starting = useRef(false);
  const unavailable = useRef(disabled);
  unavailable.current = disabled;
  const receive = useRef(onLink);
  receive.current = onLink;
  const stop = async () => {
    const old = active.current;
    active.current = null;
    if (mounted.current) {
      setSession(null);
      setImage(null);
    }
    if (old) await stopPhoneImport(old.id);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void stop().catch(console.warn);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getPhoneImport(session.id);
        if (canceled || active.current?.id !== session.id) return;
        if (next.state === "submitted" || next.state === "expired") {
          if (next.state === "submitted" && next.text) {
            receive.current(next.text);
            setMessage(
              "已收到手机链接，请确认游戏，再按“保存完整图文”。尚未下载。",
            );
          } else setMessage("二维码已失效，请重新开启。");
          await stop();
        } else timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!canceled) {
          setMessage(error instanceof Error ? error.message : String(error));
          await stop().catch(console.warn);
        }
      }
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [session]);
  useEffect(() => {
    if (disabled) void stop().catch(console.warn);
  }, [disabled]);
  const start = async () => {
    if (starting.current || disabled) return;
    starting.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await startPhoneImport();
      if (!mounted.current || unavailable.current) {
        await stopPhoneImport(next.id);
        return;
      }
      active.current = next;
      const qr = qrcode(0, "M");
      qr.addData(next.url);
      qr.make();
      setImage(qr.createDataURL(4, 16));
      setSession(next);
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : String(error));
      await stop().catch(console.warn);
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div style={{ marginBlock: 12 }}>
      <Button
        disabled={disabled || busy}
        onClick={() =>
          void (session ? stop() : start()).catch((error: unknown) =>
            setMessage(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        {busy ? (
          <BusyLabel>正在开启…</BusyLabel>
        ) : session ? (
          "关闭手机接收"
        ) : (
          "手机扫码发送链接"
        )}
      </Button>
      {session && image && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginTop: 12,
          }}
        >
          <img
            src={image}
            alt="手机发送小黑盒链接的临时二维码"
            style={{ width: 200, height: 200, imageRendering: "pixelated" }}
          />
          <div>
            <p>手机和 Deck 需在同一可信 Wi-Fi，Deck 保持唤醒。</p>
            <p>
              接收窗口有效 10 分钟，使用局域网
              HTTP。扫码只传链接；网页渲染和完整下载由 Deck 完成。
            </p>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
