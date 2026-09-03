import { Spinner } from "@decky/ui";
import type { PropsWithChildren } from "react";

export function BusyLabel({ children }: PropsWithChildren) {
  return (
    <span
      aria-live="polite"
      data-grip-busy="true"
      style={{ alignItems: "center", display: "inline-flex", gap: 8 }}
    >
      <Spinner
        aria-hidden="true"
        style={{ flex: "0 0 auto", height: "1em", width: "1em" }}
      />
      {children}
    </span>
  );
}
