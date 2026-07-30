import Ionicons from '@expo/vector-icons/Ionicons'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
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
import { Character } from '@/src/types'

const customCharacterDocumentTemplate = `---
mode: companion
language: English
correction: selective
reply_style: balanced
delivery: flexible
initiative: off
timezone: Asia/Shanghai
---

# Identity
You are a thoughtful conversation partner with a distinct point of view.

# Conversation style
Keep replies natural, direct, and suited to a chat app.
`

const createCharacterDraft = (): Character => ({
  id: '',
  name: '',
  avatar: '',
  systemPromptTemplate: customCharacterDocumentTemplate,
})

export default function CharacterEditorScreen() {
  const params = useLocalSearchParams<{ characterId: string | string[] }>()
  const characterId = Array.isArray(params.characterId) ? params.characterId[0] : params.characterId
  const isNew = characterId === 'new'
  const { ready, characters, saveBuiltInCharacterAvatar, saveCharacter } = useChat()
  const existingCharacter = useMemo(
    () => characters.find(character => character.id === characterId),
    [characterId, characters]
  )
  const [draft, setDraft] = useState<Character>(() => createCharacterDraft())
  const [saving, setSaving] = useState(false)
  const [processingAvatar, setProcessingAvatar] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBuiltIn = Boolean(existingCharacter && !existingCharacter.ownerUserId)

  useEffect(() => {
    if (existingCharacter && draft.id !== existingCharacter.id) {
      setDraft({ ...existingCharacter })
    }
  }, [draft.id, existingCharacter])

  const pickAvatar = async () => {
    try {
      setProcessingAvatar(true)
      const avatar = await pickSquareAvatar()
      if (!avatar) return
      setDraft(current => ({
        ...current,
        avatar,
      }))
      setError(null)
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'Could not process that image.')
    } finally {
      setProcessingAvatar(false)
    }
  }

  const submit = async () => {
    if (isBuiltIn) {
      if (!draft.avatar?.trim()) {
        setError('Choose an avatar first.')
        return
      }
      setSaving(true)
      setError(null)
      try {
        await saveBuiltInCharacterAvatar(draft.id, draft.avatar)
        router.back()
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Could not save the avatar.')
      } finally {
        setSaving(false)
      }
      return
    }
    if (!draft.name.trim()) {
      setError('Name is required.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const saved = await saveCharacter({
        ...draft,
        name: draft.name.trim(),
      })
      if (isNew) {
        router.replace({ pathname: '/chat/[characterId]', params: { characterId: saved.id } })
      } else {
        router.back()
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this character.')
    } finally {
      setSaving(false)
    }
  }

  if (!ready) {
    return (
      <SafeAreaView style={styles.centerState}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    )
  }

  if (!isNew && !existingCharacter && !draft.id) {
    return (
      <SafeAreaView style={styles.centerState}>
        <Text style={styles.errorTitle}>Character not found</Text>
        <Pressable onPress={() => router.back()} style={styles.backCommand}>
          <Text style={styles.backCommandLabel}>Close</Text>
        </Pressable>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.headerCommand}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{isNew ? 'Add Character' : 'Edit Character'}</Text>
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
              accessibilityLabel="Upload avatar"
              style={styles.avatarButton}
            >
              <Avatar avatar={draft.avatar} name={draft.name || '?'} size={92} />
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

          {isBuiltIn && (
            <View style={styles.sourceManagedBanner}>
              <Ionicons name="information-circle-outline" size={18} color={palette.textMuted} />
              <Text style={styles.sourceManagedText}>Built-in character details are source-managed. You can update the avatar.</Text>
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Name</Text>
            <TextInput
              value={draft.name}
              onChangeText={name => setDraft(current => ({ ...current, name }))}
              autoCapitalize="words"
              editable={!isBuiltIn}
              style={[styles.input, isBuiltIn && styles.sourceManagedInput]}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Character document</Text>
            <TextInput
              value={draft.systemPromptTemplate || ''}
              onChangeText={systemPromptTemplate => setDraft(current => ({ ...current, systemPromptTemplate }))}
              multiline
              textAlignVertical="top"
              autoCapitalize="sentences"
              autoCorrect={false}
              editable={!isBuiltIn}
              style={[styles.input, styles.documentInput, isBuiltIn && styles.sourceManagedInput]}
            />
          </View>
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
    color: '#344054',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  input: {
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#C9D1DC',
    borderRadius: 8,
    backgroundColor: palette.surface,
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  documentInput: {
    minHeight: 420,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 19,
  },
  sourceManagedInput: {
    color: palette.textMuted,
    backgroundColor: palette.surfaceMuted,
  },
  sourceManagedBanner: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: palette.surfaceMuted,
  },
  sourceManagedText: {
    flex: 1,
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  errorBanner: {
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3F2',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#FDA29B',
  },
  errorText: {
    flex: 1,
    color: '#B42318',
    fontSize: 13,
    lineHeight: 18,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: palette.background,
  },
  errorTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  backCommand: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backCommandLabel: {
    color: palette.accentPressed,
    fontSize: 15,
    fontWeight: '700',
  },
})
