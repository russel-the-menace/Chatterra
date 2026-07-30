import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native'

import { mediaUrl } from '@/src/api'
import { MessageVoice } from '@/src/types'
import { palette } from '@/src/theme'
import { WeChatVoiceWave } from '@/components/wechat-voice-wave'

const displayDuration = (duration?: number) => `${Math.max(1, Math.round(duration || 1))}\"`
const MIN_VOICE_DURATION_SECONDS = 1
const MAX_VOICE_DURATION_SECONDS = 11
const MIN_VOICE_BUBBLE_WIDTH = 92
const CHAT_HORIZONTAL_INSET = 12
const CHAT_AVATAR_SIZE = 40
const CHAT_ROW_GAP = 8

const voiceBubbleWidth = (duration: number | undefined, screenWidth: number) => {
  const maxWidth = Math.max(
    MIN_VOICE_BUBBLE_WIDTH,
    screenWidth / 2 - CHAT_HORIZONTAL_INSET - CHAT_AVATAR_SIZE - CHAT_ROW_GAP
  )
  const clampedDuration = Math.min(
    MAX_VOICE_DURATION_SECONDS,
    Math.max(MIN_VOICE_DURATION_SECONDS, duration || MIN_VOICE_DURATION_SECONDS)
  )
  const progress = (clampedDuration - MIN_VOICE_DURATION_SECONDS)
    / (MAX_VOICE_DURATION_SECONDS - MIN_VOICE_DURATION_SECONDS)
  return MIN_VOICE_BUBBLE_WIDTH + (maxWidth - MIN_VOICE_BUBBLE_WIDTH) * progress
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
  const { width: screenWidth } = useWindowDimensions()
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
        { width: voiceBubbleWidth(voice.durationSeconds, screenWidth) },
        pressed && styles.voiceMessagePressed,
      ]}
    >
      <WeChatVoiceWave
        color={isUser ? '#FFFFFF' : palette.text}
        level={waveLevel}
        mirrored
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
