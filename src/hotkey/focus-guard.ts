interface ElementLike {
  closest?: (selectors: string) => unknown;
  isContentEditable?: boolean;
  matches?: (selectors: string) => boolean;
}

export interface FocusWindow {
  BrowserWindow?: {
    document?: { activeElement?: ElementLike | null };
  };
  CompositionStateStore?: { GetCompositionState?: () => unknown };
}

const EDITABLE_SELECTOR =
  'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])';

function isEditableElement(element: ElementLike | null | undefined): boolean {
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  try {
    return Boolean(
      element.matches?.(EDITABLE_SELECTOR) ||
      element.closest?.(EDITABLE_SELECTOR),
    );
  } catch {
    return false;
  }
}

export function overlayHasEditableFocus(
  mainWindow: FocusWindow | null,
): boolean {
  let composition: unknown;
  try {
    composition = mainWindow?.CompositionStateStore?.GetCompositionState?.();
  } catch {
    return false;
  }

  // Only Overlay and Opaque route controller input to Steam. Hidden and
  // notification modes can retain a stale activeElement while the game is in
  // front, which must not prevent the hotkey from opening GRIP.
  if (composition !== 2 && composition !== 3) {
    return false;
  }
  return isEditableElement(mainWindow?.BrowserWindow?.document?.activeElement);
}
