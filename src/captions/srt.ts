import type {CaptionCue, CaptionsManifest} from '../domain/manifest-schema';

const pad = (value: number, length: number): string =>
  String(value).padStart(length, '0');

export const formatSrtTimestamp = (milliseconds: number): string => {
  const wholeMilliseconds = Math.max(0, Math.trunc(milliseconds));
  const hours = Math.floor(wholeMilliseconds / 3_600_000);
  const minutes = Math.floor((wholeMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((wholeMilliseconds % 60_000) / 1000);
  const remainder = wholeMilliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(remainder, 3)}`;
};

const normalizeText = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const formatCue = (cue: CaptionCue, index: number): string => [
  String(index + 1),
  `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
  normalizeText(cue.text),
].join('\n');

export const formatSrt = (captions: CaptionsManifest): string =>
  `${captions.cues.map(formatCue).join('\n\n')}\n`;
