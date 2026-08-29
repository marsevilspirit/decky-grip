export const INITIAL_RENDERED_SECTIONS = 1;
export const SECTION_RENDER_BATCH = 8;

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function initialRenderedSectionCount(totalSections: number): number {
  return Math.min(nonNegativeInteger(totalSections), INITIAL_RENDERED_SECTIONS);
}

export function nextRenderedSectionCount(
  currentSections: number,
  totalSections: number,
): number {
  const total = nonNegativeInteger(totalSections);
  const current = Math.min(nonNegativeInteger(currentSections), total);
  return Math.min(total, current + SECTION_RENDER_BATCH);
}
