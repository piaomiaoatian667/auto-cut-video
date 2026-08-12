export interface PipelineSignalHandle {
  signal: AbortSignal;
  received?: NodeJS.Signals;
  dispose(): void;
}

export function installPipelineSignalHandlers(
  processLike: Pick<NodeJS.Process, 'once' | 'off'> = process,
): PipelineSignalHandle {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  let disposed = false;
  const receive = (signal: NodeJS.Signals): void => {
    if (received !== undefined) return;
    received = signal;
    controller.abort(signal);
  };
  const onSigint = (): void => receive('SIGINT');
  const onSigterm = (): void => receive('SIGTERM');

  processLike.once('SIGINT', onSigint);
  processLike.once('SIGTERM', onSigterm);

  const handle: PipelineSignalHandle = {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      processLike.off('SIGINT', onSigint);
      processLike.off('SIGTERM', onSigterm);
    },
  };
  Object.defineProperty(handle, 'received', {
    configurable: false,
    enumerable: true,
    get: () => received,
  });
  return handle;
}

export const signalExitCode = (signal: NodeJS.Signals | undefined): number =>
  signal === 'SIGTERM' ? 143 : 130;
