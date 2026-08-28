const APPENDIX_PREFIX = /^附录[：:]\s*/;
const MAX_VISIBLE_CHARACTERS = 4;

export function shortSectionTitle(title: string): string {
  const normalized = title.trim();
  const meaningfulTitle = normalized.replace(APPENDIX_PREFIX, "") || normalized;
  return [...meaningfulTitle].slice(0, MAX_VISIBLE_CHARACTERS).join("");
}
