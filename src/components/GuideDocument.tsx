import { useMemo, type Ref } from "react";

import type { DownloadedGuide } from "../reader/types";

const DOCUMENT_CSS = `
.grip-reader-content { color: #dcdedf; font-size: 18px; line-height: 1.55; padding: 10px 34px 80px; }
.grip-reader-content ::selection { background: #f3c64b; color: #101820; }
.grip-reader-content img { display: block; max-width: 100%; height: auto; margin: 14px auto; border-radius: 4px; }
.grip-reader-content img[data-grip-image-url]:not([src]) { background: #17212b; min-height: 48px; opacity: 0.55; }
.grip-reader-content img[data-grip-image-state="unavailable"], .grip-reader-content img[data-grip-image-state="capacity"] { border: 1px dashed #6b747d; }
.grip-reader-content img[data-grip-image-state="ready"] { cursor: zoom-in; }
.grip-reader-content .grip-reader-section { margin: 0 auto 34px; max-width: 920px; }
.grip-reader-content .grip-reader-section-title { color: #67c1f5; font-size: 27px; margin: 24px 0 14px; }
.grip-reader-content .bb_h1, .grip-reader-content .bb_h2, .grip-reader-content .bb_h3 { color: #f3f3f3; font-weight: 700; margin: 20px 0 8px; }
.grip-reader-content .bb_h1 { font-size: 25px; }
.grip-reader-content .bb_h2 { font-size: 22px; }
.grip-reader-content .bb_h3 { font-size: 20px; }
.grip-reader-content .bb_code { background: #18232e; border-left: 4px solid #417a9b; margin: 10px 0; padding: 10px 14px; }
.grip-reader-content .bb_table, .grip-reader-content table { border-collapse: collapse; display: table; margin: 12px 0; table-layout: fixed; width: 100%; }
.grip-reader-content .bb_table_tr, .grip-reader-content tr { display: table-row; }
.grip-reader-content .bb_table_td, .grip-reader-content .bb_table_th, .grip-reader-content td, .grip-reader-content th { border: 1px solid #3d4c5b; display: table-cell; overflow-wrap: anywhere; padding: 8px; vertical-align: top; white-space: normal; }
.grip-reader-content .bb_table_th, .grip-reader-content th { background: #223241; font-weight: 700; }
.grip-reader-content .bb_link { color: #67c1f5; text-decoration: underline; }
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
      <div
        className="grip-reader-content grip-reader-guide-enter"
        key={guide.guideId}
        ref={contentRef}
      >
        {guide.sections.slice(0, renderedSectionCount).map((section) => (
          <section
            className="grip-reader-section"
            data-guide-section-id={section.id}
            key={section.id}
          >
            <div className="grip-reader-section-title">{section.title}</div>
            <GuideSectionBody html={section.html} />
          </section>
        ))}
      </div>
    </>
  );
}
