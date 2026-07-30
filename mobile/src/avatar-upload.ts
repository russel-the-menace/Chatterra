import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'

export const pickSquareAvatar = async () => {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) throw new Error('Photos permission needed. Allow photo access to choose an avatar.')

  const selection = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  })
  if (selection.canceled || !selection.assets[0]?.uri) return undefined

  const context = ImageManipulator.manipulate(selection.assets[0].uri)
  context.resize({ width: 512, height: 512 })
  const rendered = await context.renderAsync()
  const result = await rendered.saveAsync({
    base64: true,
    compress: 0.82,
    format: SaveFormat.JPEG,
  })
  if (!result.base64) throw new Error('Could not process the selected photo.')
  return `data:image/jpeg;base64,${result.base64}`
}
