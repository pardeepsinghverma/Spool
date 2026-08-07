import { requireNativeModule } from 'expo-modules-core';
import type { EventSubscription } from 'expo-modules-core';

export type ProgressEvent = {
  id: string;
  fraction: number;
  eta: number;
  line: string;
};

export type DownloadArgs = {
  id: string;
  url: string;
  title?: string;
  /** yt-dlp format selector, e.g. "137+140" or "best". */
  format?: string;
  audioOnly?: boolean;
  poToken?: string;
  visitorData?: string;
};

export type DownloadResult = { path: string; bytes: number };
export type UpdateResult = { status: string; version: string };

type YtDlpNative = {
  initialize(): Promise<string>;
  version(): Promise<string>;
  listFormats(
    url: string,
    poToken: string | null,
    visitorData: string | null,
  ): Promise<string>;
  download(args: DownloadArgs): Promise<DownloadResult>;
  cancel(id: string): Promise<void>;
  updateEngine(): Promise<UpdateResult>;
  publishToGallery(path: string, title: string, audioOnly: boolean): Promise<string>;
  addListener(event: 'onProgress', listener: (e: ProgressEvent) => void): EventSubscription;
};

const YtDlp = requireNativeModule<YtDlpNative>('YtDlp');

export default YtDlp;

export function onProgress(listener: (e: ProgressEvent) => void): EventSubscription {
  return YtDlp.addListener('onProgress', listener);
}
