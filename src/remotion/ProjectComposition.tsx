import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
} from 'remotion';
import {CompiledTimelineSchema, type CompiledTimeline} from '../domain/timeline-schema';
import {Caption} from './components/Caption';
import {componentRegistry, type RegisteredComponentId} from './registry';

const frameFromMilliseconds = (milliseconds: number, fps: number): number =>
  Math.round(milliseconds * fps / 1000);

const sortedByZIndex = <Item extends {zIndex: number}>(items: readonly Item[]): Item[] =>
  [...items].sort((left, right) => left.zIndex - right.zIndex);

const baseVisualStyle = (
  clip: CompiledTimeline['visualClips'][number],
): React.CSSProperties => ({
  height: '100%',
  objectFit: clip.fit,
  opacity: clip.opacity,
  transform: `translate(${clip.position.x}px, ${clip.position.y}px) scale(${clip.scale})`,
  width: '100%',
});

const renderVisualClip = (
  clip: CompiledTimeline['visualClips'][number],
  fps: number,
): React.ReactNode => {
  const style = baseVisualStyle(clip);
  return (
    <Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationInFrames}>
      {clip.kind === 'video'
        ? (
          <OffthreadVideo
            muted
            src={staticFile(clip.renderPath)}
            startFrom={frameFromMilliseconds(clip.sourceInMs ?? 0, fps)}
            style={style}
          />
        )
        : <Img src={staticFile(clip.renderPath)} style={style} />}
    </Sequence>
  );
};

const isRegisteredComponentId = (component: string): component is RegisteredComponentId =>
  Object.hasOwn(componentRegistry, component);

const renderOverlay = (
  overlay: CompiledTimeline['overlays'][number],
): React.ReactNode => {
  if (!isRegisteredComponentId(overlay.component)) return null;
  const OverlayComponent = componentRegistry[overlay.component]
    .component as unknown as React.ComponentType<Record<string, unknown>>;
  return (
    <Sequence key={overlay.id} from={overlay.startFrame} durationInFrames={overlay.durationInFrames}>
      <AbsoluteFill style={{zIndex: overlay.zIndex}}>
        <OverlayComponent {...overlay.props} />
      </AbsoluteFill>
    </Sequence>
  );
};

const renderCaption = (
  caption: CompiledTimeline['captions'][number],
  timeline: CompiledTimeline,
): React.ReactNode => (
  <Sequence
    key={caption.id}
    from={caption.startFrame}
    durationInFrames={caption.endFrame - caption.startFrame}
  >
    <AbsoluteFill style={{zIndex: 1000}}>
      <Caption
        text={caption.text}
        color="#FFFFFF"
        fontSize={54}
        bottomMargin={90}
      />
    </AbsoluteFill>
  </Sequence>
);

export function ProjectComposition(props: Record<string, unknown>) {
  const timeline = CompiledTimelineSchema.parse(props);

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {sortedByZIndex(timeline.visualClips).map((clip) => renderVisualClip(clip, timeline.fps))}
      {sortedByZIndex(timeline.overlays).map(renderOverlay)}
      {timeline.captions.map((caption) => renderCaption(caption, timeline))}
    </AbsoluteFill>
  );
}
