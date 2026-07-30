import Ionicons from '@expo/vector-icons/Ionicons'
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

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
  const [waveCount, setWaveCount] = useState(3)
  const playWhenLoadedRef = useRef(false)
  const suppressPlaybackUntilRef = useRef(0)

  useEffect(() => {
    if (!status.didJustFinish) return
    void player.seekTo(0)
  }, [player, status.didJustFinish])

  useEffect(() => {
    if (!status.playing) return
    setWaveCount(1)
    const interval = setInterval(() => {
      setWaveCount(current => current === 3 ? 1 : current + 1)
    }, 230)
    return () => clearInterval(interval)
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
        { width: Math.min(100, Math.max(78, 64 + (voice.durationSeconds || 4) * 4)) },
        pressed && styles.voiceMessagePressed,
      ]}
    >
      <View style={styles.speakerIcon}>
        <Ionicons
          name="volume-low-outline"
          size={21}
          color={isUser ? '#FFFFFF' : palette.text}
        />
      </View>
      <Text style={[styles.soundWaves, isUser && styles.soundWavesUser]}>{')'.repeat(waveCount)}</Text>
      <Text style={[styles.duration, isUser && styles.durationUser]}>{displayDuration(voice.durationSeconds)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  voiceMessage: {
    minHeight: 38,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  voiceMessagePressed: {
    opacity: 0.6,
  },
  speakerIcon: {
    width: 21,
    alignItems: 'center',
  },
  soundWaves: {
    minWidth: 11,
    color: palette.text,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
  },
  soundWavesUser: {
    color: '#FFFFFF',
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
