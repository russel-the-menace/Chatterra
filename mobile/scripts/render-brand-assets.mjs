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
  {
    source: 'assets/brand/chatterra-splash-light.svg',
    destination: 'assets/images/chatterra-splash-light.png',
    width: 560,
    height: 120,
  },
  {
    source: 'assets/brand/chatterra-splash-dark.svg',
    destination: 'assets/images/chatterra-splash-dark.png',
    width: 560,
    height: 120,
  },
]

await Promise.all(jobs.map(({ source, destination, size, width, height }) => (
  sharp(source, { density: 192 })
    .resize(width || size, height || size)
    .png()
    .toFile(destination)
)))

console.log('Rendered Chatterra brand assets.')
