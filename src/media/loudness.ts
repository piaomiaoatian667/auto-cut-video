export interface LoudnormStats {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

export class LoudnormError extends Error {
  readonly code = 'LOUDNORM_MEASUREMENT_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`LOUDNORM_MEASUREMENT_INVALID: ${message}`, options);
    this.name = 'LoudnormError';
  }
}

const finite = (value: unknown, field: string): number => {
  const parsed = typeof value === 'string' || typeof value === 'number'
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new LoudnormError(`non-finite ${field}`);
  }
  return parsed;
};

export const parseLoudnormStats = (stderr: string): LoudnormStats => {
  const start = stderr.indexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new LoudnormError('missing loudnorm JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse(stderr.slice(start, end + 1));
  } catch (error) {
    throw new LoudnormError('invalid loudnorm JSON', {cause: error});
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LoudnormError('loudnorm JSON must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    inputI: finite(record.input_i, 'input_i'),
    inputTp: finite(record.input_tp, 'input_tp'),
    inputLra: finite(record.input_lra, 'input_lra'),
    inputThresh: finite(record.input_thresh, 'input_thresh'),
    targetOffset: finite(record.target_offset, 'target_offset'),
  };
};

export const buildFirstPassLoudnormFilter = ({
  targetLufs,
  truePeakDb,
}: {
  targetLufs: number;
  truePeakDb: number;
}): string => `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11:print_format=json`;

export const buildSecondPassLoudnormFilter = ({
  targetLufs,
  truePeakDb,
  stats,
}: {
  targetLufs: number;
  truePeakDb: number;
  stats: LoudnormStats;
}): string => [
  `loudnorm=I=${targetLufs}`,
  `TP=${truePeakDb}`,
  'LRA=11',
  `measured_I=${stats.inputI}`,
  `measured_TP=${stats.inputTp}`,
  `measured_LRA=${stats.inputLra}`,
  `measured_thresh=${stats.inputThresh}`,
  `offset=${stats.targetOffset}`,
  'linear=true',
  'print_format=summary',
].join(':');
