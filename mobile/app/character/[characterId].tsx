import Ionicons from '@expo/vector-icons/Ionicons'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
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
import { useChat } from '@/src/chat-context'
import { layout, palette } from '@/src/theme'
import { Character } from '@/src/types'

type EditableField = Exclude<keyof Character, 'id' | 'avatar' | 'createdAt' | 'updatedAt'>

const fields: {
  key: EditableField
  label: string
  multiline?: boolean
}[] = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'company', label: 'Company' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'goal', label: 'Goal' },
  { key: 'language', label: 'Language' },
  { key: 'personality', label: 'Personality', multiline: true },
  { key: 'background', label: 'Background', multiline: true },
  { key: 'systemPromptTemplate', label: 'System Prompt Template', multiline: true },
]

const createCharacterDraft = (): Character => ({
  id: '',
  name: '',
  avatar: '',
  role: '',
  company: '',
  scenario: '',
  goal: '',
  language: 'English only',
  personality: '',
  background: '',
  systemPromptTemplate: '',
})

export default function CharacterEditorScreen() {
  const params = useLocalSearchParams<{ characterId: string | string[] }>()
  const characterId = Array.isArray(params.characterId) ? params.characterId[0] : params.characterId
  const isNew = characterId === 'new'
  const { ready, characters, saveCharacter } = useChat()
  const existingCharacter = useMemo(
    () => characters.find(character => character.id === characterId),
    [characterId, characters]
  )
  const [draft, setDraft] = useState<Character>(() => createCharacterDraft())
  const [saving, setSaving] = useState(false)
  const [processingAvatar, setProcessingAvatar] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (existingCharacter && draft.id !== existingCharacter.id) {
      setDraft({ ...existingCharacter })
    }
  }, [draft.id, existingCharacter])

  const updateField = (key: EditableField, value: string) => {
    setDraft(current => ({ ...current, [key]: value }))
  }

  const pickAvatar = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Photos permission needed', 'Allow photo access to choose a character avatar.')
        return
      }

      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      })
      if (selection.canceled || !selection.assets[0]?.uri) return

      setProcessingAvatar(true)
      const context = ImageManipulator.manipulate(selection.assets[0].uri)
      context.resize({ width: 512, height: 512 })
      const rendered = await context.renderAsync()
      const result = await rendered.saveAsync({
        base64: true,
        compress: 0.82,
        format: SaveFormat.JPEG,
      })
      if (!result.base64) throw new Error('Could not process that image.')
      setDraft(current => ({
        ...current,
        avatar: `data:image/jpeg;base64,${result.base64}`,
      }))
      setError(null)
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'Could not process that image.')
    } finally {
      setProcessingAvatar(false)
    }
  }

  const submit = async () => {
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

          {fields.map(field => (
            <View key={field.key} style={styles.field}>
              <Text style={styles.label}>{field.label}</Text>
              <TextInput
                value={String(draft[field.key] || '')}
                onChangeText={value => updateField(field.key, value)}
                multiline={field.multiline}
                textAlignVertical={field.multiline ? 'top' : 'center'}
                autoCapitalize={field.key === 'systemPromptTemplate' ? 'sentences' : 'words'}
                style={[styles.input, field.multiline && styles.multilineInput]}
              />
            </View>
          ))}
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
  multilineInput: {
    minHeight: 112,
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
