import {readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {describe, expect, it, onTestFinished} from 'vitest';
import {createTempProject} from '../../helpers/temp-project';

describe('createTempProject', () => {
  it('removes its workspace when initialization fails', async () => {
    const tempPrefix = `agent-video-init-failure-${randomUUID()}-`;
    let leaked: string[] = [];
    onTestFinished(async () => {
      await Promise.all(leaked.map((entry) => rm(path.join(tmpdir(), entry), {
        recursive: true,
        force: true,
      })));
    });

    await expect(createTempProject({
      tempPrefix,
      project: {unsupported: 1n},
    })).rejects.toBeInstanceOf(TypeError);

    leaked = (await readdir(tmpdir())).filter((entry) => entry.startsWith(tempPrefix));
    expect(leaked).toEqual([]);
  });
});
