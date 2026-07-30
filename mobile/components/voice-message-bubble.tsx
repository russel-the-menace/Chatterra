import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'

import { mediaUrl } from '@/src/api'
import { MessageVoice } from '@/src/types'
import { palette } from '@/src/theme'

const displayDuration = (duration?: number) => `${Math.max(1, Math.round(duration || 1))}\"`
const VOICE_WAVE_HEIGHT = 24
const VOICE_WAVE_WIDTH = 30.6

function WeChatVoiceWave({
  color,
  level,
}: {
  color: string
  level: number
}) {
  return (
    <Svg width={VOICE_WAVE_WIDTH} height={VOICE_WAVE_HEIGHT} viewBox="0 0 30.6 24">
      <G>
        <Path
          d="M6 12 L9.27 8.36 A4.455 4.455 0 0 1 9.27 15.64 Z"
          fill={color}
        />
        {level >= 2 && (
          <Path
            d="M12.87 5.33 A9.3675 9.3675 0 0 1 12.87 18.67 L10.72 16.68 A6.435 6.435 0 0 0 10.72 7.32 Z"
            fill={color}
          />
        )}
        {level >= 3 && (
          <Path
            d="M16.48 2.3 A14.28 14.28 0 0 1 16.48 21.7 L14.33 19.71 A11.3475 11.3475 0 0 0 14.33 4.29 Z"
            fill={color}
          />
        )}
      </G>
    </Svg>
  )
}

export function VoiceMessageBubble({
  voice,
  isUser = false,
  onLongPress,
}: {
  voice: MessageVoice
  isUser?: boolean
  onLongPress?: () => void
}) {
  const player = useAudioPlayer(mediaUrl(voice.audioUrl || ''), {
    downloadFirst: true,
    updateInterval: 150,
  })
  const status = useAudioPlayerStatus(player)
  const playWhenLoadedRef = useRef(false)
  const suppressPlaybackUntilRef = useRef(0)
  const [waveLevel, setWaveLevel] = useState(3)

  useEffect(() => {
    if (!status.didJustFinish) return
    void player.seekTo(0)
  }, [player, status.didJustFinish])

  useEffect(() => {
    if (!status.playing) {
      setWaveLevel(3)
      return
    }
    let nextLevel = 1
    setWaveLevel(nextLevel)
    const timer = setInterval(() => {
      nextLevel = nextLevel === 3 ? 1 : nextLevel + 1
      setWaveLevel(nextLevel)
    }, 220)
    return () => clearInterval(timer)
  }, [status.playing])

  const startPlayback = useCallback(async () => {
    if (status.didJustFinish) await player.seekTo(0)
    player.play()
  }, [player, status.didJustFinish])

  useEffect(() => {
    if (!status.isLoaded || !playWhenLoadedRef.current) return
    playWhenLoadedRef.current = false
    void startPlayback().catch(error => {
      console.warn('[voice] voice_message_playback_failed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      })
    })
  }, [startPlayback, status.isLoaded])

  const togglePlayback = async () => {
    if (Date.now() < suppressPlaybackUntilRef.current) return
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      })
      if (status.playing) {
        playWhenLoadedRef.current = false
        player.pause()
        return
      }
      if (!status.isLoaded) {
        playWhenLoadedRef.current = !playWhenLoadedRef.current
        return
      }
      await startPlayback()
    } catch (error) {
      console.warn('[voice] voice_message_playback_failed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      })
    }
  }

  return (
    <Pressable
      onPress={togglePlayback}
      delayLongPress={280}
      onLongPress={() => {
        suppressPlaybackUntilRef.current = Date.now() + 350
        onLongPress?.()
      }}
      accessibilityRole="button"
      accessibilityLabel={status.playing ? 'Pause voice message' : 'Play voice message'}
      accessibilityHint={status.isLoaded
        ? `${displayDuration(voice.durationSeconds)} voice message`
        : 'Loading voice message'}
      style={({ pressed }) => [
        styles.voiceMessage,
        isUser && styles.voiceMessageUser,
        { width: Math.min(146, Math.max(92, 76 + (voice.durationSeconds || 4) * 8)) },
        pressed && styles.voiceMessagePressed,
      ]}
    >
      <WeChatVoiceWave
        color={isUser ? '#FFFFFF' : palette.text}
        level={waveLevel}
      />
      <Text style={[styles.duration, isUser && styles.durationUser]}>{displayDuration(voice.durationSeconds)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  voiceMessage: {
    minHeight: 40,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  voiceMessageUser: {
    flexDirection: 'row-reverse',
  },
  voiceMessagePressed: {
    opacity: 0.6,
  },
  duration: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
  durationUser: {
    color: '#FFFFFF',
  },
})
