export interface ViewTick {
  timestamp: string;
  epochMs: number;
  views: number;
}

export interface LiveViewResponse {
  videoId: string;
  canonicalUrl: string;
  title: string;
  channelName: string;
  channelHandle: string;
  avatarUrl: string;
  publishedAt: string | null;
  fetchedAt: string;
  probeRttMs: number;
  verifiedSources: number;
  views: number;
  history: ViewTick[];
}
