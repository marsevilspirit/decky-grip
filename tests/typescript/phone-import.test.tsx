// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhoneImport } from "../../src/components/PhoneImport";
import {
  getPhoneImport,
  startPhoneImport,
  stopPhoneImport,
} from "../../src/backend";

vi.mock("../../src/backend", () => ({
  startPhoneImport: vi.fn(),
  getPhoneImport: vi.fn(),
  stopPhoneImport: vi.fn(async () => {}),
}));
vi.mock("@decky/ui", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
  Spinner: () => createElement("span", null, "busy"),
}));
const session = {
  id: "session-1",
  url: "http://steamdeck.local:54321/#temporary-token",
  expiresAt: Date.now() + 600_000,
};
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.clearAllMocks();
  vi.useRealTimers();
});
async function show(onLink = vi.fn()) {
  await act(async () =>
    root.render(createElement(PhoneImport, { disabled: false, onLink })),
  );
  await act(async () => host.querySelector("button")!.click());
}

it("opens only on demand, renders the local QR, and submits text without claiming download success", async () => {
  vi.useFakeTimers();
  vi.mocked(startPhoneImport).mockResolvedValue(session);
  vi.mocked(getPhoneImport)
    .mockResolvedValueOnce({ state: "waiting" })
    .mockResolvedValueOnce({ state: "submitted", text: "小黑盒分享链接" });
  const receive = vi.fn();
  await show(receive);
  expect(host.querySelector("img")?.src).toMatch(/^data:image\/gif;base64,/);
  expect(host.textContent).toContain("同一可信 Wi-Fi");
  expect(receive).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(receive).toHaveBeenCalledExactlyOnceWith("小黑盒分享链接");
  expect(host.textContent).toContain("尚未下载");
  expect(host.querySelector("img")).toBeNull();
  expect(stopPhoneImport).toHaveBeenCalledWith(session.id);
});

it("closes a late-starting session when the modal unmounts, without polling it", async () => {
  let resolve!: (value: typeof session) => void;
  vi.mocked(startPhoneImport).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await show();
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => resolve(session));
  expect(stopPhoneImport).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(getPhoneImport).not.toHaveBeenCalled();
});

it("closes a receiver when rendering/download begins and cleans up expirations", async () => {
  vi.mocked(startPhoneImport).mockResolvedValue(session);
  vi.mocked(getPhoneImport).mockResolvedValue({ state: "waiting" });
  await show();
  await act(async () =>
    root.render(
      createElement(PhoneImport, { disabled: true, onLink: vi.fn() }),
    ),
  );
  expect(stopPhoneImport).toHaveBeenCalledWith(session.id);
  expect(host.querySelector("img")).toBeNull();
  vi.mocked(getPhoneImport).mockResolvedValue({ state: "expired" });
  await show();
  expect(host.textContent).toContain("二维码已失效");
  expect(host.querySelector("img")).toBeNull();
});
