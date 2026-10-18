// HTTP server of the review tool (spec 023). Interface stub: the implementer fills it in.

export interface ReviewServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export function startServer(opts: {
  drafts: string;
  reviewer: string;
  port: number;
}): Promise<ReviewServer> {
  void opts;
  return Promise.reject(new Error('not implemented'));
}
