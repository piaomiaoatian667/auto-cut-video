import {useCurrentFrame} from 'remotion';

export interface BasicTitleProps {
  text: string;
}

export function BasicTitle({text}: BasicTitleProps) {
  const frame = useCurrentFrame();
  const opacity = Math.min(1, frame / 15);

  return (
    <div style={{
      alignItems: 'center',
      color: 'white',
      display: 'flex',
      fontFamily: 'sans-serif',
      fontSize: 88,
      fontWeight: 700,
      height: '100%',
      justifyContent: 'center',
      opacity,
      textAlign: 'center',
      textShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
      width: '100%',
    }}>
      {text}
    </div>
  );
}
