import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
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

function ContactRow({ character }: { character: Character }) {
  const {
    proactivePreviews,
    unreadCharacterIds,
    markCharacterRead,
  } = useChat()

  const openConversation = () => {
    markCharacterRead(character.id)
    router.push({ pathname: '/chat/[characterId]', params: { characterId: character.id } })
  }

  return (
    <Pressable
      onPress={openConversation}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${character.name}`}
      style={({ pressed }) => [styles.contactRow, pressed && styles.contactPressed]}
    >
      <Avatar avatar={character.avatar} name={character.name} size={layout.avatarSize} />
      <View style={styles.contactContent}>
        <View style={styles.contactTitleRow}>
          <Text style={styles.contactName} numberOfLines={1}>{character.name}</Text>
          {unreadCharacterIds.has(character.id) && (
            <View style={styles.unreadDot} accessibilityLabel="New message" />
          )}
        </View>
        <Text style={styles.contactPreview} numberOfLines={1}>
          {proactivePreviews[character.id] || character.personality || character.role || 'Conversation partner'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#98A2B3" />
    </Pressable>
  )
}

export default function ContactsScreen() {
  const {
    apiBaseUrl,
    ready,
    characters,
    connectionError,
    refreshCharacters,
  } = useChat()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const visibleCharacters = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return characters
    return characters.filter(character => (
      [character.name, character.role, character.company, character.personality]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    ))
  }, [characters, search])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshCharacters()
    } catch {
      // The inline connection state remains visible.
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Chatterra</Text>
          <Text style={styles.subtitle}>Conversations</Text>
        </View>
        <Pressable
          onPress={() => router.push({ pathname: '/character/[characterId]', params: { characterId: 'new' } })}
          accessibilityRole="button"
          accessibilityLabel="Add character"
          hitSlop={10}
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
        >
          <Ionicons name="add" size={25} color={palette.text} />
        </Pressable>
      </View>

      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={palette.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search"
          placeholderTextColor="#98A2B3"
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={styles.searchInput}
        />
      </View>

      {!ready ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : connectionError && characters.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="cloud-offline-outline" size={30} color={palette.textMuted} />
          <Text style={styles.stateTitle}>Server unavailable</Text>
          <Text style={styles.stateText}>{connectionError}</Text>
          <Text style={styles.endpointText}>{apiBaseUrl}</Text>
          <Pressable onPress={() => void refresh()} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={visibleCharacters}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <ContactRow character={item} />}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={(
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.accent} />
          )}
          ListHeaderComponent={connectionError ? (
            <View style={styles.warningBanner}>
              <Ionicons name="warning-outline" size={17} color={palette.warning} />
              <Text style={styles.warningText} numberOfLines={2}>{connectionError}</Text>
            </View>
          ) : null}
          ListEmptyComponent={(
            <View style={styles.emptyState}>
              <Text style={styles.stateText}>{search ? 'No matching conversations.' : 'No characters yet.'}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  header: {
    minHeight: 72,
    paddingHorizontal: layout.horizontalPadding,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: palette.text,
    fontSize: 26,
    lineHeight: 31,
    fontWeight: '800',
  },
  subtitle: {
    color: palette.textMuted,
    fontSize: 13,
    marginTop: 1,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surfaceMuted,
  },
  iconButtonPressed: {
    backgroundColor: '#D8E0E8',
  },
  searchBox: {
    height: 42,
    marginHorizontal: layout.horizontalPadding,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: palette.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
  },
  searchInput: {
    flex: 1,
    height: 40,
    paddingVertical: 0,
    color: palette.text,
    fontSize: 16,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingBottom: 24,
  },
  contactRow: {
    minHeight: 72,
    paddingHorizontal: 8,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  contactPressed: {
    backgroundColor: '#F5F7F9',
  },
  contactContent: {
    flex: 1,
    minWidth: 0,
  },
  contactTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  contactName: {
    flexShrink: 1,
    color: palette.text,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '700',
  },
  contactPreview: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#D92D20',
  },
  centerState: {
    flex: 1,
    padding: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  stateTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '700',
  },
  stateText: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  endpointText: {
    color: palette.textMuted,
    fontSize: 12,
    fontFamily: 'Menlo',
  },
  retryButton: {
    minHeight: 40,
    marginTop: 5,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  warningBanner: {
    margin: 8,
    padding: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF7ED',
  },
  warningText: {
    flex: 1,
    color: '#9A3412',
    fontSize: 13,
  },
  emptyState: {
    paddingTop: 60,
    alignItems: 'center',
  },
})
