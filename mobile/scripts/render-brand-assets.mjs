import sharp from 'sharp'

const jobs = [
  {
    source: 'assets/brand/chatterra-icon.svg',
    destination: 'assets/images/chatterra-icon.png',
    size: 1024,
  },
  {
    source: 'assets/brand/chatterra-mark.svg',
    destination: 'assets/images/chatterra-mark.png',
    size: 1024,
  },
  {
    source: 'assets/brand/chatterra-icon.svg',
    destination: 'assets/images/chatterra-favicon.png',
    size: 256,
  },
]

await Promise.all(jobs.map(({ source, destination, size }) => (
  sharp(source, { density: 192 })
    .resize(size, size)
    .png()
    .toFile(destination)
)))

console.log('Rendered Chatterra brand assets.')
