export type MainContentCandidate = {
  id: string;
  blockCount: number;
  textLength: number;
  excerpt: string;
};

export const MAX_MAIN_CONTENT_CANDIDATES = 12;
export const MAX_MAIN_CONTENT_EXCERPT = 180;
