import {describe,it,expect} from 'vitest'
import {loadPreferences,savePreferences,DEFAULT_PREFERENCES} from './preferences'
import {STUDY_ENTRIES} from './priority'
describe('preferences and study data',()=>{
 it('persists independently selected label and orientation settings',()=>{let data='';const storage={getItem:()=>data,setItem:(_k:string,v:string)=>{data=v}};savePreferences({...DEFAULT_PREFERENCES,labelMode:'none',orientation:'heading'},storage);expect(loadPreferences(storage)).toMatchObject({labelMode:'none',orientation:'heading'})})
 it('recovers from malformed or unavailable storage',()=>{expect(loadPreferences({getItem:()=>'{broken'})).toEqual(DEFAULT_PREFERENCES);expect(loadPreferences({getItem:()=>{throw Error('blocked')}})).toEqual(DEFAULT_PREFERENCES)})
 it('opens even when the browser denies access to localStorage itself',()=>{
   const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
   Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw new Error('Storage access denied')}})
   try {
     expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES)
     expect(()=>savePreferences(DEFAULT_PREFERENCES)).not.toThrow()
   } finally {
     if(original)Object.defineProperty(globalThis,'localStorage',original)
     else Reflect.deleteProperty(globalThis,'localStorage')
   }
 })
 it('preserves 38 entries, study groups, aliases, and unresolved entries',()=>{expect(STUDY_ENTRIES).toHaveLength(38);expect(STUDY_ENTRIES.filter(e=>e.group==='North / South')).toHaveLength(17);expect(STUDY_ENTRIES.filter(e=>e.review).map(e=>e.name)).toEqual(['Lake Arrowhead','Gable Dr']);expect(STUDY_ENTRIES.find(e=>e.name==='Auto Mall Pkwy / Durham Rd')?.aliases).toEqual(['Auto Mall Parkway','Durham Road'])})
})
