import Svg, { G, Path } from 'react-native-svg'

const WAVE_HEIGHT = 21.576895536
const WAVE_WIDTH = 31.83318
const WAVE_CENTER_OFFSET_X = 1.653658709

export function WeChatVoiceWave({
  color,
  centered = false,
  height = WAVE_HEIGHT,
  level = 3,
}: {
  color: string
  centered?: boolean
  height?: number
  level?: number
}) {
  const width = height * (WAVE_WIDTH / WAVE_HEIGHT)

  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`}
    >
      <G transform={centered ? `translate(${WAVE_CENTER_OFFSET_X} 0)` : undefined}>
        <Path
          d="M6 10.788447768 L9.029578126 8.176617685 A4 4 0 0 1 9.029578126 13.40027785 Z"
          fill={color}
        />
        {level >= 2 && (
          <Path
            d="M12.437853517 5.238308843 A8.5 8.5 0 0 1 12.437853517 16.338586693 L10.923064454 15.032671652 A6.5 6.5 0 0 0 10.923064454 6.544223884 Z"
            fill={color}
          />
        )}
        {level >= 3 && (
          <Path
            d="M15.846128909 2.3 A13 13 0 0 1 15.846128909 19.276895536 L14.331339846 17.970980494 A11 11 0 0 0 14.331339846 3.605915041 Z"
            fill={color}
          />
        )}
      </G>
    </Svg>
  )
}
