import { sheetUrl, type World } from './world'

// Logo cut from the sprite sheet; startups without one get the first letter of their name on a
// disc in their theme colour (the same stand-in the map uses).
export function LogoImg({ world, i, size = 32 }: { world: World; i: number; size?: number }) {
  const k = world.logo[i]
  if (k < 0) {
    const c = world.themes[world.cluster[i]].color
    return (
      <span className="logo letter" style={{ width: size, height: size, background: `rgb(${c.join(',')})`, fontSize: size * 0.5 }}>
        {(world.name[i].trim()[0] ?? '?').toUpperCase()}
      </span>
    )
  }
  const { cols, cell, width, height, url } = world.sprite
  const s = size / cell
  return (
    <span className="logo sprite" style={{
      width: size, height: size,
      backgroundImage: `url(${sheetUrl(world, url)})`,
      backgroundSize: `${width * s}px ${height * s}px`,
      backgroundPosition: `-${(k % cols) * cell * s}px -${Math.floor(k / cols) * cell * s}px`,
    }} />
  )
}
