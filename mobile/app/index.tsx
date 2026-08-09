import Ionicons from '@expo/vector-icons/Ionicons'
import { Redirect, router } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Modal,
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
import { starterMessageForCharacter } from '@/src/starter-message'
import { layout, palette } from '@/src/theme'
import { Character } from '@/src/types'

const formatContactTime = (timestamp?: string) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDifference = Math.round((today.getTime() - messageDay.getTime()) / 86_400_000)
  if (dayDifference === 0) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (dayDifference === 1) return 'Yesterday'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function SparkBadge({ characterId }: { characterId: string }) {
  const { streaksByCharacter } = useChat()
  const streak = streaksByCharacter[characterId]
  if (!streak || streak.status === 'locked' || streak.status === 'expired') return null
  const pending = streak.status === 'pending'
  const rekindling = streak.status === 'rekindling'
  const color = pending ? '#8B929C' : rekindling ? '#F58A5B' : '#F05A28'
  const text = streak.status === 'active'
    ? String(streak.days)
    : pending
      ? `${streak.daysLeft || 1}d left`
      : `Relight ${streak.rekindleProgress || 1}/3`
  return (
    <View
      style={styles.sparkBadge}
      accessibilityLabel={text}
    >
      {pending ? <Ionicons name="flame" size={16} color={color} /> : <Text style={styles.sparkFlame}>🔥</Text>}
      {rekindling
        ? <View style={styles.sparkRekindlingText}><Text style={[styles.sparkDays, { color }]} numberOfLines={1}>{text}</Text></View>
        : <Text style={[styles.sparkDays, { color }]} numberOfLines={1}>{text}</Text>}
    </View>
  )
}

function ContactRow({ character, pinned }: { character: Character; pinned: boolean }) {
  const {
    proactivePreviews,
    unreadCountsByCharacter,
    lastMessageAtByCharacter,
    markCharacterRead,
  } = useChat()
  const contactTime = formatContactTime(lastMessageAtByCharacter[character.id])

  const openConversation = () => {
    markCharacterRead(character.id)
    router.push({ pathname: '/chat/[characterId]', params: { characterId: character.id } })
  }

  return (
    <Pressable
      onPress={openConversation}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${character.name}`}
      style={({ pressed }) => [
        styles.contactRow,
        pinned && styles.contactPinned,
        pressed && styles.contactPressed,
      ]}
    >
      <View style={styles.contactAvatarWrap}>
        <Avatar avatar={character.avatar} name={character.name} size={layout.avatarSize} />
        {unreadCountsByCharacter[character.id] > 0 && (
          <View
            style={styles.unreadBadge}
            accessibilityLabel={`${unreadCountsByCharacter[character.id]} unread messages`}
          >
            <Text style={styles.unreadBadgeText}>
              {unreadCountsByCharacter[character.id] > 99 ? '99+' : unreadCountsByCharacter[character.id]}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.contactContent}>
        <View style={styles.contactTitleRow}>
          <Text style={styles.contactName} numberOfLines={1}>{character.name}</Text>
          <SparkBadge characterId={character.id} />
        </View>
        <Text style={styles.contactPreview} numberOfLines={1}>
          {proactivePreviews[character.id] || starterMessageForCharacter(character)}
        </Text>
      </View>
      {!!contactTime && <Text style={styles.contactTime}>{contactTime}</Text>}
      {pinned && <View pointerEvents="none" style={styles.contactPinnedSeparator} />}
    </Pressable>
  )
}

export default function ContactsScreen() {
  const {
    ready,
    userId,
    characters,
    connectionError,
    pinnedCharacterIds,
    pinnedCharacterOrder,
    lastMessageAtByCharacter,
    refreshCharacters,
  } = useChat()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [settingsVisible, setSettingsVisible] = useState(false)

  const visibleCharacters = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const filtered = query ? characters.filter(character => (
      [character.name, character.role, character.company, character.personality]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    )) : characters
    return [...filtered]
      .map((character, index) => ({ character, index }))
      .sort((left, right) => {
        const leftPinned = pinnedCharacterIds.has(left.character.id)
        const rightPinned = pinnedCharacterIds.has(right.character.id)
        if (leftPinned !== rightPinned) return rightPinned ? 1 : -1
        if (leftPinned && rightPinned) {
          return pinnedCharacterOrder.indexOf(left.character.id) - pinnedCharacterOrder.indexOf(right.character.id)
        }
        const lastMessageComparison = (lastMessageAtByCharacter[right.character.id] || '')
          .localeCompare(lastMessageAtByCharacter[left.character.id] || '')
        if (lastMessageComparison !== 0) return lastMessageComparison
        return left.index - right.index
      })
      .map(({ character }) => character)
  }, [characters, lastMessageAtByCharacter, pinnedCharacterIds, pinnedCharacterOrder, search])

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

  const openCharacterCreator = () => {
    setSettingsVisible(false)
    router.push({ pathname: '/character/[characterId]', params: { characterId: 'new' } })
  }

  const openProfileEditor = () => {
    setSettingsVisible(false)
    router.push('/profile')
  }

  if (ready && !userId) return <Redirect href="/login" />

  return (
    <>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Chatterra</Text>
            <Text style={styles.subtitle}>Conversations</Text>
          </View>
          <Pressable
            onPress={() => setSettingsVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={10}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <Ionicons name="settings-outline" size={22} color={palette.text} />
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
            <Text style={styles.stateTitle}>Could not load conversations</Text>
            <Text style={styles.stateText}>{connectionError}</Text>
            <Pressable
              disabled={refreshing}
              onPress={() => void refresh()}
              style={({ pressed }) => [styles.retryButton, (pressed || refreshing) && styles.retryButtonPressed]}
            >
              <Text style={styles.retryButtonText}>{refreshing ? 'Retrying...' : 'Retry'}</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={visibleCharacters}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ContactRow character={item} pinned={pinnedCharacterIds.has(item.id)} />
            )}
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

      <Modal
        transparent
        visible={settingsVisible}
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.settingsModal}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            onPress={() => setSettingsVisible(false)}
            style={styles.settingsBackdrop}
          />
          <SafeAreaView style={styles.settingsDrawer} edges={['top', 'bottom', 'right']}>
            <View style={styles.settingsDrawerHeader}>
              <Text style={styles.settingsDrawerTitle}>Settings</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close settings"
                onPress={() => setSettingsVisible(false)}
                style={styles.settingsCloseButton}
              >
                <Ionicons name="close" size={22} color={palette.text} />
              </Pressable>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add character"
              onPress={openCharacterCreator}
              style={({ pressed }) => [styles.settingsRow, pressed && styles.settingsRowPressed]}
            >
              <View style={styles.settingsRowIcon}>
                <Ionicons name="person-add-outline" size={21} color={palette.text} />
              </View>
              <Text style={styles.settingsRowLabel}>add character</Text>
              <Ionicons name="chevron-forward" size={19} color={palette.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit profile"
              onPress={openProfileEditor}
              style={({ pressed }) => [styles.settingsRow, pressed && styles.settingsRowPressed]}
            >
              <View style={styles.settingsRowIcon}>
                <Ionicons name="person-circle-outline" size={22} color={palette.text} />
              </View>
              <Text style={styles.settingsRowLabel}>edit profile</Text>
              <Ionicons name="chevron-forward" size={19} color={palette.textMuted} />
            </Pressable>
          </SafeAreaView>
        </View>
      </Modal>
    </>
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
    fontWeight: '400',
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
  settingsModal: {
    flex: 1,
    flexDirection: 'row',
  },
  settingsBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 24, 39, 0.32)',
  },
  settingsDrawer: {
    width: 292,
    maxWidth: '84%',
    marginLeft: 'auto',
    backgroundColor: palette.surface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: palette.border,
  },
  settingsDrawerHeader: {
    minHeight: 62,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  settingsDrawerTitle: {
    color: palette.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700',
  },
  settingsCloseButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsRow: {
    minHeight: 68,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  settingsRowPressed: {
    backgroundColor: palette.surfaceMuted,
  },
  settingsRowIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surfaceMuted,
    borderRadius: 8,
  },
  settingsRowLabel: {
    flex: 1,
    color: palette.text,
    fontSize: 16,
    lineHeight: 21,
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
    backgroundColor: '#F6F7F8',
    marginHorizontal: -8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderBottomColor: 'transparent',
  },
  contactPinned: {
    backgroundColor: '#F5F7F9',
    marginHorizontal: -8,
    paddingHorizontal: 16,
    borderBottomColor: 'transparent',
  },
  contactPinnedSeparator: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: -StyleSheet.hairlineWidth,
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.border,
  },
  contactContent: {
    flex: 1,
    minWidth: 0,
  },
  contactAvatarWrap: {
    width: layout.avatarSize,
    height: layout.avatarSize,
    flexShrink: 0,
    position: 'relative',
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
  sparkBadge: {
    position: 'relative',
    maxWidth: 130,
    height: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  sparkFlame: { fontSize: 16, lineHeight: 17, zIndex: 2 },
  sparkRekindlingText: { marginLeft: -7, paddingLeft: 8, paddingRight: 5, borderRadius: 7, backgroundColor: 'rgba(17,24,39,0.08)' },
  sparkDays: {
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  contactPreview: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  contactTime: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    marginTop: 3,
    color: '#98A2B3',
    fontSize: 11,
    lineHeight: 15,
    fontVariant: ['tabular-nums'],
  },
  unreadBadge: {
    position: 'absolute',
    top: -7,
    right: -8,
    zIndex: 1,
    minWidth: 19.8,
    height: 19.8,
    paddingHorizontal: 5.4,
    borderRadius: 9.9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FF4D55',
    shadowColor: '#FF4D55',
    shadowOpacity: 0.18,
    shadowRadius: 3.6,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
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
  retryButton: {
    minHeight: 40,
    marginTop: 5,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
  },
  retryButtonPressed: {
    opacity: 0.68,
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
