const [major, minor] = process.versions.node.split('.').map(Number)

const supported = (
  (major === 20 && minor >= 19)
  || (major === 22 && minor >= 13)
  || major >= 24
)

if (!supported) {
  console.error(
    `Chatterra Mobile requires Node 20.19+, 22.13+, or 24+. Current version: ${process.version}.\n`
    + 'Use the version in mobile/.nvmrc before starting Expo.'
  )
  process.exit(1)
}
