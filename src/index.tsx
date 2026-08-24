import { definePlugin } from "@decky/api";
import { staticClasses } from "@decky/ui";

import { getPositions, savePosition } from "./backend";
import { GripPanel } from "./components/GripPanel";
import { GripController } from "./grip-controller";
import { RuntimeStatusStore } from "./runtime-status";
import { createSteamGuideRuntime } from "./steam/runtime";

function BookmarkIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="1em"
      viewBox="0 0 24 24"
      width="1em"
    >
      <path d="M7 3.5C7 2.67 7.67 2 8.5 2h7c.83 0 1.5.67 1.5 1.5V22l-5-3.2L7 22V3.5Z" />
    </svg>
  );
}

export default definePlugin(() => {
  const status = new RuntimeStatusStore();
  const controller = new GripController({
    backend: {
      getPositions,
      savePosition,
    },
    runtimeFactory: createSteamGuideRuntime,
    status,
  });
  void controller.start();

  return {
    name: "GRIP",
    titleView: <div className={staticClasses.Title}>GRIP</div>,
    content: <GripPanel status={status} />,
    icon: <BookmarkIcon />,
    onDismount() {
      controller.stop();
      console.info("[GRIP] Unloaded");
    },
  };
});
