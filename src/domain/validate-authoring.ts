import type {Edit} from './edit-schema';
import type {Project} from './project-schema';
import type {Script} from './script-schema';

export interface AuthoringInputs {
  project: Project;
  script: Script;
  edit: Edit;
}

export class AuthoringValidationError extends Error {
  readonly code = 'SCRIPT_SEGMENT_TEXT_TOO_LONG';

  constructor(
    readonly segmentId: string,
    readonly graphemeCount: number,
    readonly maximumGraphemes: number,
  ) {
    super(
      `script segment ${segmentId} has ${graphemeCount} graphemes; `
      + `maximum is ${maximumGraphemes}`,
    );
    this.name = 'AuthoringValidationError';
  }
}

const segmenter = new Intl.Segmenter('zh-CN', {granularity: 'grapheme'});

const countGraphemes = (text: string): number =>
  Array.from(segmenter.segment(text)).length;

export function validateAuthoringInputs({project, script}: AuthoringInputs): void {
  const maximumGraphemes = project.captions.maximumChineseCharacters;
  for (const segment of script.segments) {
    const graphemeCount = countGraphemes(segment.text);
    if (graphemeCount > maximumGraphemes) {
      throw new AuthoringValidationError(
        segment.id,
        graphemeCount,
        maximumGraphemes,
      );
    }
  }
}
