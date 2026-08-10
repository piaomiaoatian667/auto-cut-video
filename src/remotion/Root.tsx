import {Composition} from 'remotion';
import {CompiledTimelineSchema} from '../domain/timeline-schema';
import {ProjectComposition} from './ProjectComposition';

export function RemotionRoot() {
  return (
    <Composition
      id="Project"
      component={ProjectComposition}
      calculateMetadata={({props}) => {
        const timeline = CompiledTimelineSchema.parse(props);
        return {
          durationInFrames: timeline.durationInFrames,
          fps: timeline.fps,
          width: timeline.width,
          height: timeline.height,
        };
      }}
    />
  );
}
