import { Spinner } from "@decky/ui";
import type { PropsWithChildren } from "react";

export function BusyLabel({ children }: PropsWithChildren) {
  return (
    <span aria-live="polite" data-grip-busy="true">
      <Spinner aria-hidden="true" height="1em" width="1em" />
      {children}
    </span>
  );
}
