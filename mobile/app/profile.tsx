import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Avatar } from '@/components/avatar'
import { pickSquareAvatar } from '@/src/avatar-upload'
import { useChat } from '@/src/chat-context'
import { layout, palette } from '@/src/theme'

export default function ProfileEditorScreen() {
  const { ready, userAvatar, userName, userTranslationTargetLanguage, saveUserProfile, logout } = useChat()
  const [displayName, setDisplayName] = useState(userName || '')
  const [avatar, setAvatar] = useState(userAvatar || '')
  const [translationTargetLanguage, setTranslationTargetLanguage] = useState(userTranslationTargetLanguage || 'English')
  const [nameEdited, setNameEdited] = useState(false)
  const [avatarEdited, setAvatarEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [processingAvatar, setProcessingAvatar] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!nameEdited) setDisplayName(userName || '')
  }, [nameEdited, userName])

  useEffect(() => {
    if (!avatarEdited) setAvatar(userAvatar || '')
  }, [avatarEdited, userAvatar])

  const pickAvatar = async () => {
    try {
      setProcessingAvatar(true)
      const selectedAvatar = await pickSquareAvatar()
      if (!selectedAvatar) return
      setAvatarEdited(true)
      setAvatar(selectedAvatar)
      setError(null)
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'Could not process that image.')
    } finally {
      setProcessingAvatar(false)
    }
  }

  const submit = async () => {
    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setError('Name is required.')
      return
    }

    try {
      setSaving(true)
      setError(null)
      await saveUserProfile({ displayName: trimmedName, avatar: avatar || undefined, translationTargetLanguage })
      router.back()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save your profile.')
    } finally {
      setSaving(false)
    }
  }

  const signOut = async () => {
    setSigningOut(true)
    await logout()
    router.replace('/login')
  }

  if (!ready) {
    return (
      <SafeAreaView style={styles.centerState}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.headerCommand}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Edit profile</Text>
        <Pressable
          onPress={() => void submit()}
          disabled={saving || processingAvatar}
          hitSlop={10}
          style={styles.headerCommand}
        >
          {saving
            ? <ActivityIndicator size="small" color={palette.accentPressed} />
            : <Text style={[styles.saveLabel, processingAvatar && styles.commandDisabled]}>Save</Text>}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.form}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.avatarSection}>
            <Pressable
              onPress={() => void pickAvatar()}
              disabled={processingAvatar}
              accessibilityLabel="Upload profile photo"
              style={styles.avatarButton}
            >
              <Avatar avatar={avatar} name={displayName || 'Me'} size={92} muted />
              <View style={styles.avatarEditBadge}>
                {processingAvatar
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Ionicons name="camera" size={17} color="#FFFFFF" />}
              </View>
            </Pressable>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Name</Text>
            <TextInput
              value={displayName}
              onChangeText={value => {
                setNameEdited(true)
                setDisplayName(value)
              }}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={120}
              placeholder="Your name"
              placeholderTextColor={palette.textMuted}
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Destination translation language</Text>
            <View style={styles.selectBox}>
              <TextInput
                value={translationTargetLanguage}
                onChangeText={setTranslationTargetLanguage}
                style={styles.input}
                placeholder="English"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          <Pressable
            onPress={() => void signOut()}
            disabled={saving || processingAvatar || signingOut}
            accessibilityRole="button"
            style={({ pressed }) => [styles.signOutButton, pressed && styles.signOutButtonPressed]}
          >
            {signingOut
              ? <ActivityIndicator size="small" color={palette.danger} />
              : <Text style={styles.signOutLabel}>Sign out</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  keyboardArea: {
    flex: 1,
  },
  header: {
    height: 56,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  headerCommand: {
    width: 72,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: palette.text,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  cancelLabel: {
    color: palette.textMuted,
    fontSize: 15,
  },
  saveLabel: {
    color: palette.accentPressed,
    fontSize: 15,
    fontWeight: '700',
  },
  commandDisabled: {
    opacity: 0.45,
  },
  form: {
    flexGrow: 1,
    paddingHorizontal: layout.horizontalPadding,
    paddingTop: 18,
    paddingBottom: 36,
    gap: 14,
    backgroundColor: palette.background,
  },
  avatarSection: {
    alignItems: 'center',
    paddingBottom: 4,
  },
  avatarButton: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEditBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accentPressed,
    borderWidth: 2,
    borderColor: palette.background,
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
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  selectBox: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
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
  signOutButton: {
    minHeight: 44,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.danger,
    borderRadius: 8,
    backgroundColor: palette.surfaceMuted,
  },
  signOutButtonPressed: {
    backgroundColor: palette.background,
  },
  signOutLabel: {
    color: palette.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.background,
  },
})
