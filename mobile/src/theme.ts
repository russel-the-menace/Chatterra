import { Appearance } from 'react-native'

const isDark = Appearance.getColorScheme() === 'dark'

const lightPalette = {
  accent: '#34C759',
  accentPressed: '#2BAE4C',
  accentSoft: '#E4F9E8',
  accentBorder: '#78DA90',
  accentMuted: '#A6E8B5',
  accentDeep: '#23883D',
  background: '#F3F5F7',
  surface: '#FFFFFF',
  surfaceMuted: '#E8EDF2',
  text: '#111827',
  textMuted: '#667085',
  border: '#D8DEE6',
  userBubble: '#34C759',
  assistantBubble: '#FFFFFF',
  danger: '#C2413B',
  warning: '#B45309',
  shadow: '#0F172A',
}

const darkPalette = {
  accent: '#2DB14C',
  accentPressed: '#24933E',
  accentSoft: '#173B22',
  accentBorder: '#347C45',
  accentMuted: '#245D31',
  accentDeep: '#1C7B35',
  background: '#1D1E20',
  surface: '#252628',
  surfaceMuted: '#303236',
  text: '#F0F1F3',
  textMuted: '#A4A9B1',
  border: '#414348',
  userBubble: '#2DB14C',
  assistantBubble: '#303236',
  danger: '#FF7B73',
  warning: '#F6C96B',
  shadow: '#000000',
}

export const palette = isDark ? darkPalette : lightPalette

export const layout = {
  horizontalPadding: 16,
  compactRadius: 8,
  avatarSize: 48,
}
