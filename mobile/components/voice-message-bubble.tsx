import Ionicons from '@expo/vector-icons/Ionicons'
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useCallback, useEffect, useRef } from 'react'
import { Animated as RNAnimated, Pressable, StyleSheet, Text } from 'react-native'

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
  const waveOpacity = useRef(new RNAnimated.Value(1)).current

  useEffect(() => {
    if (!status.didJustFinish) return
    void player.seekTo(0)
  }, [player, status.didJustFinish])

  useEffect(() => {
    if (!status.playing) {
      waveOpacity.stopAnimation()
      waveOpacity.setValue(1)
      return
    }
    const animation = RNAnimated.loop(RNAnimated.sequence([
      RNAnimated.timing(waveOpacity, {
        toValue: 0.42,
        duration: 220,
        useNativeDriver: true,
      }),
      RNAnimated.timing(waveOpacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]))
    animation.start()
    return () => animation.stop()
  }, [status.playing, waveOpacity])

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
      <RNAnimated.View
        style={[
          styles.soundWaves,
          isUser ? styles.soundWavesUser : styles.soundWavesAssistant,
          { opacity: waveOpacity },
        ]}
      >
        <Ionicons name="wifi-outline" size={24} color={isUser ? '#FFFFFF' : palette.text} />
      </RNAnimated.View>
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
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  soundWavesUser: {
    transform: [{ rotate: '90deg' }],
  },
  soundWavesAssistant: {
    transform: [{ rotate: '-90deg' }],
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
