// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImportGuideModal } from "../../src/components/ImportGuideModal";
import { GuideDownloadTasks } from "../../src/reader/download";

vi.mock("../../src/components/PhoneImport", () => ({
  PhoneImport: ({ onLink }: { onLink: (text: string) => void }) =>
    createElement(
      "button",
      {
        onClick: () =>
          onLink("https://www.xiaoheihe.cn/app/bbs/link/4aec6fe8edfc"),
      },
      "接收手机链接",
    ),
}));

vi.mock("@decky/ui", () => ({
  ModalRoot: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  Button: (props: Record<string, unknown>) => createElement("button", props),
  Spinner: () => createElement("span", null, "busy"),
  TextField: ({ label, ...props }: { label: string }) =>
    createElement("input", { "aria-label": label, ...props }),
  DropdownItem: ({
    label,
    selectedOption,
    rgOptions,
    disabled,
    onChange,
  }: {
    label: string;
    selectedOption: string;
    rgOptions: Array<{ data: string; label: string }>;
    disabled: boolean;
    onChange: (option: { data: string }) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value: selectedOption,
        disabled,
        onChange: (event: { target: { value: string } }) =>
          onChange({ data: event.target.value }),
      },
      rgOptions.map((option) =>
        createElement(
          "option",
          { key: option.data, value: option.data },
          option.label,
        ),
      ),
    ),
}));

const host = document.createElement("div");
document.body.appendChild(host);
let root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
});
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  )!;
async function share(
  value = "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed",
) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("confirms the game, shows immediate rendering feedback, and waits for the offline job before success", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const downloads = new GuideDownloadTasks(save);
  const onOpen = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <ImportGuideModal
        downloads={downloads}
        onOpen={onOpen}
        games={[{ data: "1113000", label: "女神异闻录4 黄金版" }]}
      />,
    ),
  );
  await share();
  await act(async () => button("保存完整图文").click());
  expect(save).toHaveBeenCalledWith(
    { appId: "1113000", guideId: "heybox-249c72219fed" },
    expect.any(Function),
    expect.any(AbortSignal),
    true,
  );
  expect(host.textContent).toContain("正在渲染文章");
  expect(host.textContent).not.toContain("正文和图片已完整保存");
  await act(async () => button("接收手机链接").click());
  expect(host.querySelector("input")?.value).toContain("249c72219fed");
  expect(host.textContent).toContain("正在渲染文章");
  await act(async () => finish());
  expect(host.textContent).toContain("正文和图片已完整保存");
  await act(async () => button("立即阅读").click());
  expect(onOpen).toHaveBeenCalledWith({
    appId: "1113000",
    guideId: "heybox-249c72219fed",
  });
});

it("never labels a partial-image failure successful and does not invent a game association", async () => {
  const downloads = new GuideDownloadTasks(async () => {
    throw new Error("图片仅保存 2/3，尚未完整离线");
  });
  await act(async () =>
    root.render(
      <ImportGuideModal
        downloads={downloads}
        onOpen={async () => {}}
        games={[]}
      />,
    ),
  );
  await share();
  expect(button("保存完整图文").disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ImportGuideModal
        downloads={downloads}
        onOpen={async () => {}}
        games={[{ data: "1113000", label: "P4G" }]}
      />,
    ),
  );
  await share();
  await act(async () => button("保存完整图文").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("2/3");
  expect(host.textContent).not.toContain("正文和图片已完整保存");
  expect(button("重试导入")).toBeTruthy();
});

it("does not reuse another game's active import as a successful association", async () => {
  const downloads = new GuideDownloadTasks(() => new Promise(() => {}));
  void downloads.start({ appId: "1", guideId: "heybox-249c72219fed" });
  await act(async () =>
    root.render(
      <ImportGuideModal
        downloads={downloads}
        onOpen={async () => {}}
        games={[{ data: "2", label: "另一款游戏" }]}
      />,
    ),
  );
  await share();
  await act(async () => button("保存完整图文").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "正在后台导入",
  );
  expect(host.textContent).not.toContain("正文和图片已完整保存");
});

it.each(["text", "phone", "game"])(
  "clears the prior guide's success feedback when the %s selection changes",
  async (field) => {
    const save = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <ImportGuideModal
          downloads={new GuideDownloadTasks(save)}
          onOpen={async () => {}}
          games={[
            { data: "1113000", label: "P4G" },
            { data: "1", label: "另一款游戏" },
          ]}
        />,
      ),
    );
    await share();
    await act(async () => button("保存完整图文").click());
    expect(host.textContent).toContain("正文和图片已完整保存");
    if (field === "text") {
      await share("https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858");
    } else if (field === "phone") {
      await act(async () => button("接收手机链接").click());
    } else {
      await act(async () => {
        const select = host.querySelector("select")!;
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(host.textContent).not.toContain("正文和图片已完整保存");
    expect(button("立即阅读")).toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
    expect(button("保存完整图文").disabled).toBe(false);
  },
);
