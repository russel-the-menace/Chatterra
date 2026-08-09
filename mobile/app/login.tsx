import Ionicons from '@expo/vector-icons/Ionicons'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ApiError } from '@/src/api'
import { useChat } from '@/src/chat-context'
import { layout, Palette, useThemePalette } from '@/src/theme'

export default function LoginScreen() {
  const { login } = useChat()
  const palette = useThemePalette()
  const styles = useMemo(() => createStyles(palette), [palette])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const normalizedUsername = username.trim()
    if (!normalizedUsername || !password) {
      setError('Enter your username and password.')
      return
    }

    try {
      setSubmitting(true)
      setError(null)
      await login(normalizedUsername, password)
    } catch (loginError) {
      if (loginError instanceof ApiError && loginError.status === 401) {
        setError('Invalid username or password.')
      } else {
        setError(loginError instanceof Error ? loginError.message : 'Could not sign in.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          <View style={styles.brandMark}>
            <Ionicons name="chatbubble-ellipses" size={31} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Chatterra</Text>
          <Text style={styles.subtitle}>Sign in to your conversations</Text>

          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={styles.label}>Username</Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                returnKeyType="next"
                placeholder="Username"
                placeholderTextColor={palette.textMuted}
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                placeholder="Password"
                placeholderTextColor={palette.textMuted}
                style={styles.input}
              />
            </View>

            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Pressable
              onPress={() => void submit()}
              disabled={submitting}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.submitButton,
                pressed && !submitting && styles.submitButtonPressed,
                submitting && styles.submitButtonDisabled,
              ]}
            >
              {submitting
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text style={styles.submitLabel}>Sign in</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const createStyles = (palette: Palette) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  keyboardArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: layout.horizontalPadding * 2,
    paddingBottom: 48,
  },
  brandMark: {
    width: 64,
    height: 64,
    marginBottom: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: palette.accent,
  },
  title: {
    color: palette.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: palette.textMuted,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 4,
  },
  form: {
    marginTop: 34,
    gap: 16,
  },
  field: {
    gap: 6,
  },
  label: {
    color: palette.text,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  input: {
    height: 48,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
    color: palette.text,
    fontSize: 16,
  },
  errorBanner: {
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: palette.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.danger,
  },
  errorText: {
    flex: 1,
    color: palette.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  submitButton: {
    height: 48,
    marginTop: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: palette.accent,
  },
  submitButtonPressed: {
    backgroundColor: palette.accentPressed,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
})
