type WeChatVoiceWaveProps = {
  color: string
  level?: number
  mirrored?: boolean
  size?: number
}

// Matches the mobile voice bubble mark: a small wedge and two concentric arcs.
export function WeChatVoiceWave({
  color,
  level = 3,
  mirrored = false,
  size = 22,
}: WeChatVoiceWaveProps): JSX.Element {
  const width = size * (31.83318 / 21.576895536)
  const transform = mirrored ? 'translate(31.83318 0) scale(-1 1)' : undefined

  return (
    <svg
      className="wechat-voice-wave"
      width={width}
      height={size}
      viewBox="0 0 31.83318 21.576895536"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={transform} fill={color}>
        <path d="M6 10.788447768 L9.029578126 8.176617685 A4 4 0 0 1 9.029578126 13.40027785 Z" />
        {level >= 2 && (
          <path d="M12.437853517 5.238308843 A8.5 8.5 0 0 1 12.437853517 16.338586693 L10.923064454 15.032671652 A6.5 6.5 0 0 0 10.923064454 6.544223884 Z" />
        )}
        {level >= 3 && (
          <path d="M15.846128909 2.3 A13 13 0 0 1 15.846128909 19.276895536 L14.331339846 17.970980494 A11 11 0 0 0 14.331339846 3.605915041 Z" />
        )}
      </g>
    </svg>
  )
}
