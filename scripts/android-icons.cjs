// Draws the Android launcher icons and splash screens from the same artwork as the Windows icon.
// Run: node scripts/android-icons.cjs   (needs Playwright's Chromium)
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const RES = path.join(__dirname, '..', 'android/app/src/main/res')
const DEFS = `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d4356"/><stop offset="1" stop-color="#14202a"/></linearGradient>
    <radialGradient id="scan" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#e8eef2"/><stop offset="1" stop-color="#8fa3b1"/></radialGradient>
  </defs>`
const ART = `
  <ellipse cx="256" cy="246" rx="150" ry="118" fill="url(#scan)"/>
  <ellipse cx="256" cy="246" rx="128" ry="98" fill="#5d6f7c"/>
  <ellipse cx="200" cy="222" rx="52" ry="58" fill="#1b2731"/>
  <ellipse cx="312" cy="222" rx="52" ry="58" fill="#1b2731"/>
  <circle cx="256" cy="300" r="28" fill="#f4f7f9"/>
  <circle cx="256" cy="300" r="11" fill="#5d6f7c"/>
  <rect x="96" y="392" width="320" height="44" rx="22" fill="#3f9b62"/>
  <rect x="128" y="408" width="140" height="12" rx="6" fill="#d9f2e2"/>`
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${DEFS}${body}</svg>`
// Artwork centred and kept inside the adaptive-icon safe zone (66 of 108 dp).
const fit = (k) => `<g transform="translate(256 256) scale(${k}) translate(-256 -282)">${ART}</g>`

const LEGACY = svg(`<rect x="16" y="16" width="480" height="480" rx="96" fill="url(#bg)"/>${fit(0.92)}`)
const ROUND = svg(`<circle cx="256" cy="256" r="240" fill="url(#bg)"/>${fit(0.8)}`)
const FOREGROUND = svg(fit(0.7))

const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

;(async () => {
  const b = await chromium.launch()
  const p = await b.newPage({ deviceScaleFactor: 1 })
  const shot = async (markup, w, h, file, bg = 'transparent') => {
    await p.setViewportSize({ width: w, height: h })
    await p.setContent(`<html><body style="margin:0;background:${bg};width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">${markup}</body></html>`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await p.screenshot({ path: file, omitBackground: bg === 'transparent' })
  }
  const sized = (s, px) => s.replace('width="512" height="512"', `width="${px}" height="${px}"`)
  for (const [d, k] of Object.entries(DENS)) {
    await shot(sized(LEGACY, 48 * k), 48 * k, 48 * k, path.join(RES, `mipmap-${d}/ic_launcher.png`))
    await shot(sized(ROUND, 48 * k), 48 * k, 48 * k, path.join(RES, `mipmap-${d}/ic_launcher_round.png`))
    await shot(sized(FOREGROUND, 108 * k), 108 * k, 108 * k, path.join(RES, `mipmap-${d}/ic_launcher_foreground.png`))
  }
  // Splash (older Android): black with the icon in the middle. Sizes as Capacitor's template.
  for (const f of fs.readdirSync(RES).filter((x) => x.startsWith('drawable'))) {
    const file = path.join(RES, f, 'splash.png')
    if (!fs.existsSync(file)) continue
    const out = execFileSync('python3', ['-c', 'import sys;from PIL import Image;print(*Image.open(sys.argv[1]).size)', file]).toString().trim().split(' ').map(Number)
    const [w, h] = out
    const icon = Math.round(Math.min(w, h) * 0.28)
    await shot(sized(LEGACY, icon), w, h, file, '#000000')
  }
  await b.close()
})()
