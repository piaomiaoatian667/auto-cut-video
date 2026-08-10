import {useCurrentFrame} from 'remotion';

export interface CaptionProps {
  text: string;
  color: string;
  fontSize: number;
  bottomMargin: number;
}

export function Caption({text, color, fontSize, bottomMargin}: CaptionProps) {
  useCurrentFrame();

  return (
    <div style={{
      bottom: bottomMargin,
      color,
      fontFamily: 'sans-serif',
      fontSize,
      fontWeight: 700,
      left: 120,
      lineHeight: 1.25,
      position: 'absolute',
      right: 120,
      textAlign: 'center',
      textShadow: '0 4px 18px rgba(0, 0, 0, 0.75)',
      whiteSpace: 'pre-wrap',
    }}>
      {text}
    </div>
  );
}
