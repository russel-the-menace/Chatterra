import { Image } from 'expo-image'
import { StyleSheet, Text, View } from 'react-native'

import { palette } from '@/src/theme'

type AvatarProps = {
  avatar?: string
  name: string
  size?: number
  muted?: boolean
}

const isImageAvatar = (avatar?: string) => Boolean(
  avatar && /^(data:image\/|https?:\/\/|file:|content:)/i.test(avatar)
)

export function Avatar({ avatar, name, size = 48, muted = false }: AvatarProps) {
  const style = {
    width: size,
    height: size,
    borderRadius: Math.min(12, size * 0.24),
  }

  if (isImageAvatar(avatar)) {
    return <Image source={{ uri: avatar }} style={style} contentFit="cover" transition={120} />
  }

  return (
    <View style={[styles.fallback, style, muted && styles.fallbackMuted]}>
      <Text style={[styles.initial, { fontSize: Math.max(13, size * 0.38) }]}>
        {(avatar || name.trim().slice(0, 1) || '?').toUpperCase()}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
  },
  fallbackMuted: {
    backgroundColor: '#DCE4ED',
  },
  initial: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
})
