export type LabelMode = 'all' | 'priority' | 'none'
export interface Preferences { labelMode: LabelMode; highlight: boolean; orientation: 'north'|'heading'; maxSpeed: number; sound: boolean }
export const DEFAULT_PREFERENCES: Preferences = { labelMode:'all', highlight:true, orientation:'north', maxSpeed:13.4, sound:false }
const KEY = 'fremont-patrol:preferences:v1'
export function loadPreferences(storage?: Pick<Storage,'getItem'>): Preferences {
  try {
    const p=JSON.parse((storage ?? globalThis.localStorage).getItem(KEY) || '{}')
    return { labelMode:['all','priority','none'].includes(p.labelMode)?p.labelMode:'all', highlight:typeof p.highlight==='boolean'?p.highlight:true, orientation:p.orientation==='heading'?'heading':'north', maxSpeed:[8.94,13.4,17.88].includes(p.maxSpeed)?p.maxSpeed:13.4, sound:p.sound===true }
  } catch {return {...DEFAULT_PREFERENCES}}
}
export function savePreferences(value: Preferences, storage?: Pick<Storage,'setItem'>) {try {(storage ?? globalThis.localStorage).setItem(KEY,JSON.stringify(value))}catch {/* Storage can be disabled in private browsing or local-file documents. */}}
