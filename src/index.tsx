import { definePlugin } from "@decky/api";
import { staticClasses } from "@decky/ui";

import { GripPanel } from "./components/GripPanel";

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

export default definePlugin(() => ({
  name: "GRIP",
  titleView: <div className={staticClasses.Title}>GRIP</div>,
  content: <GripPanel />,
  icon: <BookmarkIcon />,
  onDismount() {
    console.info("[GRIP] Unloaded");
  },
}));
