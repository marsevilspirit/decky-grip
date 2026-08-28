export interface DownloadedGuideSection {
  id: string;
  title: string;
  html: string;
}

export interface DownloadedGuide {
  guideId: string;
  title: string;
  author: string;
  sourceUrl: string;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  sections: DownloadedGuideSection[];
}

export interface ReaderPosition {
  scrollTop: number;
  sectionId: string | null;
  anchorText: string | null;
  anchorOffset: number;
  updatedAt: number;
}
