import { DialogBodyText, DialogHeader } from "@decky/ui";
import { useMemo, type Ref } from "react";

import type { DownloadedGuide } from "../reader/types";

const DOCUMENT_CSS = `
.grip-reader-content { margin: 0; padding: 10px 34px 80px; }
.grip-reader-content img { display: block; max-width: 100%; height: auto; margin: 14px auto; }
.grip-reader-content img[data-grip-image-url]:not([src]) { min-height: 48px; }
.grip-reader-content img[data-grip-image-state="ready"] { cursor: zoom-in; }
.grip-reader-content .grip-reader-section { margin: 0 auto 34px; max-width: 920px; }
.grip-reader-content .grip-reader-section-title { margin: 24px 0 14px; }
.grip-reader-content .bb_h1, .grip-reader-content .bb_h2, .grip-reader-content .bb_h3 { font-weight: bold; margin: 20px 0 8px; }
.grip-reader-content .bb_h1 { font-size: 1.5em; }
.grip-reader-content .bb_h2 { font-size: 1.3em; }
.grip-reader-content .bb_h3 { font-size: 1.1em; }
.grip-reader-content .bb_code { border-left: 2px solid currentColor; margin: 10px 0; padding: 10px 14px; }
.grip-reader-content .bb_table, .grip-reader-content table { border-collapse: collapse; display: table; margin: 12px 0; table-layout: fixed; width: 100%; }
.grip-reader-content .bb_table_tr, .grip-reader-content tr { display: table-row; }
.grip-reader-content .bb_table_td, .grip-reader-content .bb_table_th, .grip-reader-content td, .grip-reader-content th { border: 1px solid currentColor; display: table-cell; overflow-wrap: anywhere; padding: 8px; vertical-align: top; white-space: normal; }
.grip-reader-content .bb_table_th, .grip-reader-content th { font-weight: bold; }
.grip-reader-content .bb_link { text-decoration: underline; }
`;

function GuideSectionBody({ html }: { html: string }) {
  // React 19 replaces innerHTML when this object changes, detaching hydrated images.
  const markup = useMemo(() => ({ __html: html }), [html]);
  return <div data-guide-search-body dangerouslySetInnerHTML={markup} />;
}

interface GuideDocumentProps {
  guide: Pick<DownloadedGuide, "guideId" | "sections">;
  renderedSectionCount: number;
  contentRef: Ref<HTMLDivElement>;
}

/** Render already-sanitized guide HTML; the page owns scheduling, hydration and scroll restoration. */
export function GuideDocument({
  guide,
  renderedSectionCount,
  contentRef,
}: GuideDocumentProps) {
  return (
    <>
      <style>{DOCUMENT_CSS}</style>
      <DialogBodyText
        className="grip-reader-content"
        key={guide.guideId}
        ref={contentRef}
      >
        {guide.sections.slice(0, renderedSectionCount).map((section) => (
          <section
            className="grip-reader-section"
            data-guide-section-id={section.id}
            key={section.id}
          >
            <DialogHeader className="grip-reader-section-title">
              {section.title}
            </DialogHeader>
            <GuideSectionBody html={section.html} />
          </section>
        ))}
      </DialogBodyText>
    </>
  );
}
