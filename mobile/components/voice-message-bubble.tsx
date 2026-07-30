import Ionicons from '@expo/vector-icons/Ionicons'
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useEffect, useRef } from 'react'
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
  const player = useAudioPlayer(mediaUrl(voice.audioUrl || ''), { updateInterval: 150 })
  const status = useAudioPlayerStatus(player)
  const suppressPlaybackUntilRef = useRef(0)

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    })
  }, [])

  useEffect(() => {
    if (!status.didJustFinish) return
    void player.seekTo(0)
  }, [player, status.didJustFinish])

  const togglePlayback = () => {
    if (Date.now() < suppressPlaybackUntilRef.current) return
    if (status.playing) {
      player.pause()
      return
    }
    if (status.didJustFinish) void player.seekTo(0)
    player.play()
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
      accessibilityHint={`${displayDuration(voice.durationSeconds)} voice message`}
      style={({ pressed }) => [
        styles.voiceMessage,
        { width: Math.min(220, Math.max(132, 104 + (voice.durationSeconds || 4) * 11)) },
        pressed && styles.voiceMessagePressed,
      ]}
    >
      <View style={styles.waveIcon}>
        <Ionicons
          name={status.playing ? 'pause' : 'volume-high-outline'}
          size={25}
          color={isUser ? '#14532D' : palette.text}
        />
      </View>
      <View style={styles.waveBars}>
        {[0, 1, 2, 3].map(index => (
          <View
            key={index}
            style={[
              styles.waveBar,
              { height: 6 + index * 3 },
              isUser && styles.waveBarUser,
              status.playing && styles.waveBarPlaying,
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
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  voiceMessagePressed: {
    opacity: 0.6,
  },
  waveIcon: {
    width: 25,
    alignItems: 'center',
  },
  waveBars: {
    flex: 1,
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  waveBar: {
    width: 2,
    borderRadius: 1,
    backgroundColor: '#A0A8B4',
  },
  waveBarPlaying: {
    backgroundColor: palette.accent,
  },
  waveBarUser: {
    backgroundColor: '#3D7C2B',
  },
  duration: {
    color: palette.text,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  durationUser: {
    color: '#14532D',
  },
})
