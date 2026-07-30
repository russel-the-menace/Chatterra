import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useCallback, useEffect, useRef } from 'react'
import { Animated as RNAnimated, Pressable, StyleSheet, Text, View } from 'react-native'

import { mediaUrl } from '@/src/api'
import { MessageVoice } from '@/src/types'
import { palette } from '@/src/theme'

const displayDuration = (duration?: number) => `${Math.max(1, Math.round(duration || 1))}\"`

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
  const waveOpacities = useRef([
    new RNAnimated.Value(1),
    new RNAnimated.Value(1),
    new RNAnimated.Value(1),
  ]).current

  useEffect(() => {
    if (!status.didJustFinish) return
    void player.seekTo(0)
  }, [player, status.didJustFinish])

  useEffect(() => {
    if (!status.playing) return
    const frame = (visible: number) => RNAnimated.parallel(
      waveOpacities.map((opacity, index) => RNAnimated.timing(opacity, {
        toValue: index < visible ? 1 : 0.22,
        duration: 170,
        useNativeDriver: true,
      }))
    )
    const animation = RNAnimated.loop(RNAnimated.sequence([
      frame(1),
      frame(2),
      frame(3),
      frame(1),
    ]))
    animation.start()
    return () => animation.stop()
  }, [status.playing, waveOpacities])

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
      <View style={[styles.soundWaves, isUser && styles.soundWavesUser]}>
        {waveOpacities.map((opacity, index) => (
          <RNAnimated.View
            key={index}
            style={[
              styles.soundWaveArc,
              index === 0 && styles.soundWaveArcSmall,
              index === 1 && styles.soundWaveArcMedium,
              index === 2 && styles.soundWaveArcLarge,
              { borderColor: isUser ? '#FFFFFF' : palette.text, opacity },
            ]}
          />
        ))}
      </View>
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
  soundWaves: {
    width: 20,
    height: 20,
    position: 'relative',
  },
  soundWavesUser: {
    transform: [{ scaleX: -1 }],
  },
  soundWaveArc: {
    position: 'absolute',
    borderLeftWidth: 0,
    borderRightWidth: 1.8,
    borderTopWidth: 1.8,
    borderBottomWidth: 1.8,
  },
  soundWaveArcSmall: {
    width: 4,
    height: 8,
    top: 6,
    left: 1,
    borderTopRightRadius: 5,
    borderBottomRightRadius: 5,
  },
  soundWaveArcMedium: {
    width: 5,
    height: 13,
    top: 3.5,
    left: 7,
    borderTopRightRadius: 7,
    borderBottomRightRadius: 7,
  },
  soundWaveArcLarge: {
    width: 5,
    height: 18,
    top: 1,
    left: 14,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
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
