import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { GeoJSONSource, Map as LibreMap } from 'maplibre-gl'
import type { FeatureCollection, LineString } from 'geojson'
import type { RoadGraph } from '../src/engine'

// Every driving test uses the checked-in OSM snapshot. Do not replace this with
// a small invented street grid: real OSM way boundaries matter to the controls.
const graph = JSON.parse(readFileSync(new URL('../public/data/fremont-roads.json', import.meta.url), 'utf8')) as RoadGraph
type MapElement = HTMLElement & { __patrolMap?: LibreMap }

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.locator('.map-status')).toHaveText('ROAD NETWORK VERIFIED')
  await expect(page.getByRole('button', { name: 'Begin drive', exact: true })).toBeEnabled()
  await expect(page.locator('.patrol-marker')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement | null)?.__patrolMap
    return Boolean(map?.loaded() && map.getSource('patrol-roads') && map.isSourceLoaded('patrol-roads') &&
      map.queryRenderedFeatures({ layers: ['patrol-road-fill'] }).length > 0)
  }), { message: 'Verified Fremont road geometry must actually render on the map', timeout: 30_000 }).toBe(true)
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    const canvas = map.getContainer().getBoundingClientRect()
    const marker = document.querySelector('.patrol-marker')!.getBoundingClientRect()
    const x = marker.x + marker.width / 2 - canvas.x
    const y = marker.y + marker.height / 2 - canvas.y
    const position = map.unproject([x, y])
    const center = map.getCenter()
    return {
      position: [position.lng, position.lat], center: [center.lng, center.lat],
      centerOffset: Math.hypot(x - canvas.width / 2, y - canvas.height / 2),
      speed: Number(document.querySelector('.gauge-number')!.textContent!.replace('MPH', '').trim()),
    }
  })
}

function meters(a: number[], b: number[]) {
  return Math.hypot((a[0] - b[0]) * 88_200, (a[1] - b[1]) * 111_200)
}

async function distanceFromActiveRoad(page: Page) {
  const position = (await snapshot(page)).position
  const line = await page.evaluate(async () => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    const data = await (map.getSource('patrol-active-road') as GeoJSONSource).getData() as FeatureCollection<LineString>
    return data.features[0]?.geometry.coordinates ?? []
  })
  return Math.min(...line.slice(1).map((end, i) => {
    const start = line[i]
    const dx = (end[0] - start[0]) * 88_200
    const dy = (end[1] - start[1]) * 111_200
    const px = (position[0] - start[0]) * 88_200
    const py = (position[1] - start[1]) * 111_200
    const fraction = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return Math.hypot(px - fraction * dx, py - fraction * dy)
  }))
}

async function accelerate(page: Page, minimumMph = 5) {
  await page.keyboard.down('w')
  await expect.poll(async () => (await snapshot(page)).speed).toBeGreaterThanOrEqual(minimumMph)
}

test('real Fremont roads render; vehicle moves on a valid starting road, brakes, pauses, and resets', async ({ page }) => {
  await ready(page)
  expect(graph.metadata.source).toBe('OpenStreetMap')
  expect(graph.edges.length).toBeGreaterThan(1000)
  const startId = await page.getByLabel('STARTING POINT').inputValue()
  const start = graph.edges.find(edge => edge.id === startId)!
  expect(start).toBeTruthy()
  const initial = await snapshot(page)
  expect(meters(initial.position, start.geometry[0])).toBeLessThan(1)
  expect(initial.speed).toBe(0)
  await expect.poll(async () => (await snapshot(page)).centerOffset).toBeLessThan(2)

  // W must work with the Begin/Pause drive button still focused after a click.
  await page.getByRole('button', { name: 'Begin drive', exact: true }).click()
  await accelerate(page, 6)
  const driving = await snapshot(page)
  expect(meters(driving.position, initial.position)).toBeGreaterThan(1)
  expect(meters(driving.center, initial.center)).toBeGreaterThan(1)
  // Follow moves the world beneath the car rather than pinning world position.
  expect(driving.centerOffset).toBeLessThan(15)
  await expect.poll(() => distanceFromActiveRoad(page)).toBeLessThan(1)
  await expect.poll(() => page.locator('.session-info strong').evaluate(element => parseFloat(element.textContent!)),
    { message: 'Distance must accumulate across deferred React state updates while driving' }).toBeGreaterThan(0)
  await page.keyboard.up('w')
  await page.keyboard.down('s')
  await expect.poll(async () => (await snapshot(page)).speed).toBe(0)
  await page.keyboard.up('s')

  await accelerate(page, 4)
  await page.keyboard.up('w')
  await page.keyboard.press('Space')
  await expect(page.locator('.gauge-status')).toHaveText('SIMULATION PAUSED')
  const paused = await snapshot(page)
  // Observe actual animation frames while paused; do not freeze the test clock.
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0
    const tick = () => { if (++frames >= 20) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }))
  const stillPaused = await snapshot(page)
  expect(meters(stillPaused.position, paused.position)).toBeLessThan(0.05)
  expect(stillPaused.speed).toBe(paused.speed)
  await page.getByRole('button', { name: 'Reset drive', exact: true }).click()
  await expect(page.locator('.gauge-number')).toHaveText('0MPH')
  await expect.poll(async () => meters((await snapshot(page)).position, start.geometry[0])).toBeLessThan(0.1)
  await expect(page.locator('.gauge-status')).toHaveText('SIMULATION PAUSED')
  await expect(page.locator('.session-info strong')).toHaveText('0.00 mi explored')
})

test('a selected legal maneuver remains visible through driving updates', async ({ page }) => {
  await ready(page)
  const choice = page.locator('.legal-options button').first()
  await expect(choice).toBeVisible()
  const label = await choice.innerText()
  await choice.click()
  await expect(choice).toHaveClass('selected')
  await expect(page.locator('.patrol-marker')).toHaveAttribute('aria-label', /selected\./)
  const initial = await snapshot(page)
  // Choosing a turn leaves its button focused; it must not swallow W.
  await accelerate(page, 3)
  await expect.poll(async () => meters((await snapshot(page)).position, initial.position)).toBeGreaterThan(1)
  await page.keyboard.up('w')
  // The global pause shortcut must still work with the turn button focused.
  await page.keyboard.press('Space')
  await expect(page.locator('.gauge-status')).toHaveText('SIMULATION PAUSED')
  const paused = await snapshot(page)
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0
    const tick = () => { if (++frames >= 20) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }))
  expect(meters((await snapshot(page)).position, paused.position)).toBeLessThan(0.05)
  expect(meters((await snapshot(page)).position, initial.position)).toBeGreaterThan(0.5)
  await expect(page.locator('.legal-options button.selected')).toHaveText(label)
  await expect(page.locator('.patrol-marker')).toHaveAttribute('aria-label', /selected\./)
  await expect(page.locator('.patrol-marker [data-selected-turn]')).toBeVisible()
  // A starting-point selection must hand keyboard driving back to the page.
  await page.getByLabel('STARTING POINT').selectOption({ index: 1 })
  await accelerate(page, 3)
  await page.keyboard.up('w')
  await page.keyboard.press('Space')
  await expect(page.locator('.gauge-status')).toHaveText('SIMULATION PAUSED')
})

test('label modes control graph and basemap street names, and settings survive reload', async ({ page }) => {
  await ready(page)
  // A fallback basemap has no provider symbols. This probe uses actual Fremont
  // roads and the public style API to cover the provider label suppression
  // contract even when the external basemap cannot be fetched.
  await page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    map.addLayer({ id: 'provider-road-label-probe', type: 'symbol', source: 'patrol-roads',
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'] } })
  })
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Drive settings' })
  await dialog.getByLabel('Street names').selectOption('priority')
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    return { visibility: map.getLayoutProperty('patrol-road-labels', 'visibility'),
      filter: map.getFilter('patrol-road-labels'), provider: map.getLayoutProperty('provider-road-label-probe', 'visibility') }
  })).toEqual({ visibility: 'visible', filter: ['all', ['!=', ['get', 'name'], ''], ['==', ['get', 'priority'], true]], provider: 'none' })
  await dialog.getByLabel('Street names').selectOption('none')
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    return map.getStyle().layers!.filter(layer => layer.type === 'symbol' && layer.layout && 'text-field' in layer.layout)
      .every(layer => map.getLayoutProperty(layer.id, 'visibility') === 'none')
  })).toBe(true)
  await dialog.getByLabel('Street names').selectOption('all')
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('.map-canvas') as MapElement).__patrolMap!
    return { visibility: map.getLayoutProperty('patrol-road-labels', 'visibility'),
      filter: map.getFilter('patrol-road-labels'), provider: map.getLayoutProperty('provider-road-label-probe', 'visibility') }
  })).toEqual({ visibility: 'visible', filter: ['!=', ['get', 'name'], ''], provider: 'none' })
  await dialog.getByLabel('Street names').selectOption('priority')
  await dialog.getByLabel('Map orientation').selectOption('heading')
  await dialog.getByLabel('Driving speed').selectOption('8.94')
  await dialog.getByLabel('Highlight priority roads').uncheck()
  await dialog.getByRole('button', { name: 'Got it' }).click()
  await page.reload()
  await expect(page.locator('.map-status')).toHaveText('ROAD NETWORK VERIFIED')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(dialog.getByLabel('Street names')).toHaveValue('priority')
  await expect(dialog.getByLabel('Map orientation')).toHaveValue('heading')
  await expect(dialog.getByLabel('Driving speed')).toHaveValue('8.94')
  await expect(dialog.getByLabel('Highlight priority roads')).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Driving help' }).click()
  await expect(page.getByRole('dialog', { name: 'Driving controls' })).toContainText('Brake to a stop')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('390px layout keeps map, controls and dialogs within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  for (const selector of ['.main-content', '.map-section', '.drive-panel']) {
    const bounds = await page.locator(selector).boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  }
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Drive settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Street names').selectOption('none')
  await dialog.getByRole('button', { name: 'Got it' }).click()
  await expect(page.locator('.map-bottom')).toContainText('No street names')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('external basemap failure keeps actual locally cached road geometry driveable', async ({ page }) => {
  await page.route(/\/basemap\/|https:\/\/tiles\.openfreemap\.org\//, route => route.abort('failed'))
  await ready(page)
  await expect(page.locator('.map-warning')).toContainText('cached OpenStreetMap streets are shown')
  // Source queries alone can succeed before a GPU frame is composited. Inspect
  // screenshot pixels too, masking DOM controls so a blank canvas cannot pass.
  const pixels = await page.locator('.maplibregl-canvas').screenshot({
    mask: ['.patrol-marker', '.map-status', '.map-compass', '.map-controls', '.map-driving-state', '.map-warning', '.maplibregl-control-container']
      .map(selector => page.locator(selector)),
    maskColor: '#e8ece7',
  })
  const whiteRoadPixels = await page.evaluate(async data => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    let visibleRoadPixels = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > 245 && rgba[i + 1] > 245 && rgba[i + 2] > 240) visibleRoadPixels++
    }
    return visibleRoadPixels
  }, pixels.toString('base64'))
  expect(whiteRoadPixels, 'Actual cached roads must be visible, not just present in source queries').toBeGreaterThan(1000)
  await accelerate(page, 3)
  await page.keyboard.up('w')
  await page.keyboard.press('Space')
  await expect(page.locator('.gauge-status')).toHaveText('SIMULATION PAUSED')
})
