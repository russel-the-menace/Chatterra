import AsyncStorage from '@react-native-async-storage/async-storage'
import { PropsWithChildren, createContext, createElement, useContext, useEffect, useMemo, useState } from 'react'
import { Appearance, useColorScheme } from 'react-native'

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

export type Palette = typeof lightPalette
export type AppearancePreference = 'automatic' | 'light' | 'dark'

const APPEARANCE_STORAGE_KEY = 'chatterra.mobile.appearance'
type ThemeValue = {
  appearance: AppearancePreference
  palette: Palette
  setAppearance: (appearance: AppearancePreference) => void
}
const ThemeContext = createContext<ThemeValue | null>(null)

const paletteFor = (appearance: AppearancePreference, systemScheme: ReturnType<typeof useColorScheme>): Palette => (
  appearance === 'dark' || (appearance === 'automatic' && systemScheme === 'dark')
    ? darkPalette
    : lightPalette
)

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const systemScheme = useColorScheme()
  const [appearance, setStoredAppearance] = useState<AppearancePreference>('automatic')
  useEffect(() => {
    void AsyncStorage.getItem(APPEARANCE_STORAGE_KEY).then(value => {
      if (value === 'light' || value === 'dark') setStoredAppearance(value)
    }).catch(() => undefined)
  }, [])
  const setAppearance = (nextAppearance: AppearancePreference) => {
    setStoredAppearance(nextAppearance)
    void AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, nextAppearance).catch(() => undefined)
  }
  const value = useMemo(() => ({
    appearance,
    palette: paletteFor(appearance, systemScheme),
    setAppearance,
  }), [appearance, systemScheme])
  return createElement(ThemeContext.Provider, { value }, children)
}

export const useTheme = (): ThemeValue => {
  const theme = useContext(ThemeContext)
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider.')
  return theme
}

export const palette = isDark ? darkPalette : lightPalette

export const useThemePalette = (): Palette => (
  useTheme().palette
)

export const layout = {
  horizontalPadding: 16,
  compactRadius: 8,
  avatarSize: 48,
}
