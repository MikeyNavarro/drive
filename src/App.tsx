import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Compass, Crosshair, Flag, Layers, Map as MapIcon, MapPin, Maximize2, Minus, Navigation, Pause, Play, Plus, Radio, RotateCcw, Route, Settings2, Shield, Sparkles, X, AlertTriangle, BookOpen, LockKeyhole } from 'lucide-react'
import type { Map as LibreMap } from 'maplibre-gl'
import { MapView } from './components/MapView'
import { advance, createVehicle, legalManeuvers, validateGraph } from './engine'
import type { RoadGraph, VehicleState } from './engine'
import { loadPreferences, savePreferences } from './lib/preferences'
import type { Preferences, LabelMode } from './lib/preferences'
import { STUDY_ENTRIES, PRIORITY_NAMES, normalizeRoad } from './lib/priority'

type GraphStatus = 'loading'|'ready'|'error'
const shortName=(name:string)=>name.replace(/Boulevard/g,'Blvd').replace(/Parkway/g,'Pkwy').replace(/Avenue/g,'Ave').replace(/Road/g,'Rd').replace(/Drive/g,'Dr').replace(/Street/g,'St')
const compass=(b:number)=>['N','NE','E','SE','S','SW','W','NW'][Math.round(b/45)%8]
const isInput=(target:EventTarget|null)=>target instanceof HTMLElement && (['INPUT','SELECT','TEXTAREA'].includes(target.tagName)||target.isContentEditable)

export default function App() {
  const [preferences,setPreferences]=useState<Preferences>(loadPreferences)
  const [graph,setGraph]=useState<RoadGraph|null>(null)
  const [graphStatus,setGraphStatus]=useState<GraphStatus>('loading')
  const [error,setError]=useState('')
  const [vehicle,setVehicle]=useState<VehicleState|null>(null)
  const [paused,setPaused]=useState(true)
  const [follow,setFollow]=useState(true)
  const [group,setGroup]=useState<'North / South'|'East / West'>('North / South')
  const [settings,setSettings]=useState(false)
  const [help,setHelp]=useState(false)
  const [fullscreen,setFullscreen]=useState(false)
  const [distance,setDistance]=useState(0)
  const [selectedStart,setSelectedStart]=useState('')
  const [selectedRoad,setSelectedRoad]=useState<string|null>(null)
  const [notice,setNotice]=useState('')
  const keys=useRef({throttle:false,brake:false})
  const vehicleRef=useRef<VehicleState|null>(null)
  const mapRef=useRef<LibreMap|null>(null)
  const mapContainer=useRef<HTMLDivElement>(null)

  const loadGraph=useCallback(async()=>{
    setGraphStatus('loading');setError('')
    try {
      const response=await fetch('/data/fremont-roads.json',{cache:'no-cache'})
      if(!response.ok || !response.headers.get('content-type')?.includes('json')) throw Error('The verified Fremont road snapshot is not available yet.')
      const loaded=await response.json() as RoadGraph
      const validation=validateGraph(loaded)
      if(validation.errors.length) throw Error(`Road validation failed: ${validation.errors.slice(0,3).join('; ')}`)
      setGraph(loaded);setGraphStatus('ready')
    } catch(e){setError(e instanceof Error?e.message:'Unable to load the road network.');setGraphStatus('error');setGraph(null)}
  },[])
  useEffect(()=>{void loadGraph()},[loadGraph])
  useEffect(()=>{savePreferences(preferences)},[preferences])
  useEffect(()=>{vehicleRef.current=vehicle},[vehicle])

  const starts=useMemo(()=>{
    if(!graph)return []
    const namesByNode=new Map<string,Set<string>>()
    for(const edge of graph.edges){for(const id of [edge.from,edge.to]){if(!namesByNode.has(id))namesByNode.set(id,new Set());if(edge.name)namesByNode.get(id)!.add(edge.name)}}
    const preferred=['Fremont Boulevard','Mowry Avenue','Stevenson Boulevard','Paseo Padre Parkway','Walnut Avenue']
    const choices=[...namesByNode.entries()].filter(([,names])=>names.size>=2&&[...names].filter(n=>preferred.includes(n)).length>=2)
      .map(([node,names])=>({node,names:[...names].sort((a,b)=>preferred.indexOf(a)-preferred.indexOf(b))}))
    const unique=new Map<string,{id:string;name:string}>()
    for(const {node,names} of choices){const name=names.slice(0,2).map(shortName).join(' & ');const edge=graph.edges.find(e=>e.from===node&&e.name===names[0]);if(edge&&!unique.has(name))unique.set(name,{id:edge.id,name})}
    if(!unique.size){for(const edge of graph.edges){if(preferred.includes(edge.name)&&!unique.has(edge.name))unique.set(edge.name,{id:edge.id,name:shortName(edge.name)})}}
    return [...unique.values()].sort((a,b)=>a.name.includes('Fremont')?-1:b.name.includes('Fremont')?1:a.name.localeCompare(b.name)).slice(0,12)
  },[graph])
  const reset=useCallback((edgeId?:string)=>{
    if(!graph)return
    const state=createVehicle(graph,edgeId||selectedStart||starts[0]?.id)
    vehicleRef.current=state;setVehicle(state);setPaused(true);setFollow(true);setDistance(0);keys.current={throttle:false,brake:false}
  },[graph,selectedStart,starts])
  useEffect(()=>{if(graph){const id=starts[0]?.id;setSelectedStart(id||'');const state=createVehicle(graph,id);setVehicle(state);vehicleRef.current=state}},[graph,starts])
  const maneuverOptions=useMemo(()=>graph&&vehicle?legalManeuvers(graph,vehicle):[],[graph,vehicle])
  const edge=useMemo(()=>graph?.edges.find(e=>e.id===vehicle?.edgeId),[graph,vehicle?.edgeId])
  const nextNames=useMemo(()=>[...new Set(maneuverOptions.map(m=>graph?.edges.find(e=>e.id===m.edgeId)?.name).filter(n=>n&&n!==edge?.name))],[maneuverOptions,graph,edge?.name])
  const choose=useCallback((id:string)=>{
    if(!graph||!vehicleRef.current)return
    const next=advance(graph,vehicleRef.current,0,{maneuver:id})
    vehicleRef.current=next;setVehicle(next)
    setNotice('Turn selected · hold W to continue')
  },[graph])
  const selectDirection=useCallback((type:string)=>{
    if(!graph||!vehicleRef.current)return
    const options=legalManeuvers(graph,vehicleRef.current).filter(o=>o.type===type)
    if(options.length===1){choose(options[0].edgeId);setNotice(`${type[0].toUpperCase()+type.slice(1)} turn selected`)}
    else if(options.length>1)setNotice(`Multiple ${type} turns. Choose a road in the driving panel.`)
    else setNotice(`No legal ${type} maneuver at the next junction.`)
  },[graph,choose])
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      if(isInput(e.target)||settings||help)return
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','w','s','a','d','r','W','S','A','D','R'].includes(e.key))e.preventDefault()
      switch(e.key.toLowerCase()){
        case 'w':case 'arrowup': keys.current.throttle=true;setPaused(false);break
        case 's':case 'arrowdown': keys.current.brake=true;break
        case 'a':case 'arrowleft':if(!e.repeat)selectDirection('left');break
        case 'd':case 'arrowright':if(!e.repeat)selectDirection('right');break
        case ' ':if(!e.repeat)setPaused(p=>!p);break
        case 'r':if(!e.repeat)reset();break
      }
    }
    const up=(e:KeyboardEvent)=>{if(['w','arrowup'].includes(e.key.toLowerCase()))keys.current.throttle=false;if(['s','arrowdown'].includes(e.key.toLowerCase()))keys.current.brake=false}
    const blur=()=>{keys.current={throttle:false,brake:false};setPaused(true)}
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur)
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur)}
  },[settings,help,selectDirection,reset])
  useEffect(()=>{if(settings||help){setPaused(true);keys.current={throttle:false,brake:false}}},[settings,help])
  useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){setSettings(false);setHelp(false)}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[])
  useEffect(()=>{
    if(!graph||paused)return
    let frame=0,last=0,lastRender=0,travel=0
    const tick=(time:number)=>{
      const dt=last?Math.min((time-last)/1000,.1):0;last=time
      const current=vehicleRef.current
      if(current){
        const next=advance(graph,current,dt,{...keys.current,maxSpeedMps:preferences.maxSpeed})
        travel+=next.speedMps*dt
        vehicleRef.current=next
        if(time-lastRender>32){const traveled=travel;travel=0;setVehicle({...next});setDistance(d=>d+traveled);lastRender=time}
      }
      frame=requestAnimationFrame(tick)
    }
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame)
  },[graph,paused,preferences.maxSpeed])
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(timer)},[notice])
  const graphNames=useMemo(()=>new Set(graph?.edges.map(e=>normalizeRoad(e.name))),[graph])
  const covered=STUDY_ENTRIES.filter(e=>[e.name,...e.aliases].some(n=>graphNames.has(normalizeRoad(n)))).length
  const update=<K extends keyof Preferences>(key:K,value:Preferences[K])=>setPreferences(p=>({...p,[key]:value}))
  const toggleFullscreen=async()=>{if(!document.fullscreenElement){await mapContainer.current?.requestFullscreen();setFullscreen(true)}else{await document.exitFullscreen();setFullscreen(false)}}

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Fremont Patrol home"><span className="brand-icon"><Shield size={23}/></span><span>FREMONT<span className="brand-sub">PATROL SIMULATOR</span></span><span className="beta">BETA</span></a><div className="top-location"><span className="status-dot"/> FREMONT, CALIFORNIA <span className="divider">/</span> GEOGRAPHY TRAINING</div><div className="header-actions"><button className="icon-button" aria-label="Driving help" onClick={()=>setHelp(true)}><CircleHelp size={19}/></button><button className="icon-button" aria-label="Open settings" onClick={()=>setSettings(true)}><Settings2 size={19}/></button><span className="avatar">FP</span></div></header>
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-caption">YOUR TRAINING</div><nav className="mode-nav"><button className="mode-item active"><Route size={19}/><span>Free Drive<small>Explore at your own pace</small></span><span className="active-dot"/></button><button className="mode-item" disabled title="Planned for a later milestone"><BookOpen size={18}/><span>Street Study<small>Learn your priority roads</small></span><LockKeyhole size={13}/></button><button className="mode-item" disabled title="Available in a later milestone"><Radio size={18}/><span>Dispatch<small>Put your knowledge to work</small></span><LockKeyhole size={13}/></button></nav>
        <div className="sidebar-line"/><div className="sidebar-caption study-heading">PRIORITY STREETS<span>38</span></div><p className="sidebar-copy">Your personal geography field guide.</p><div className="group-tabs"><button className={group==='North / South'?'selected':''} onClick={()=>setGroup('North / South')}>North / South <span>17</span></button><button className={group==='East / West'?'selected':''} onClick={()=>setGroup('East / West')}>East / West <span>21</span></button></div><div className="street-list">{STUDY_ENTRIES.filter(e=>e.group===group).map(entry=>{const matched=[entry.name,...entry.aliases].find(n=>graphNames.has(normalizeRoad(n)));const actual=graph?.edges.find(e=>matched&&normalizeRoad(e.name)===normalizeRoad(matched))?.name;return <button key={entry.name} className={`street-item ${selectedRoad===actual&&actual?'selected':''}`} onClick={()=>{if(actual){setSelectedRoad(selectedRoad===actual?null:actual);setNotice(`Highlighted ${shortName(actual)} on the map`)}else setNotice(entry.review||'Outside the current central Fremont road snapshot.')}} title={entry.review||(actual?'Verified in the local road snapshot':'Outside the current driving area')}><span className={`street-dot ${actual?'verified':''}`}/><span>{entry.name}</span>{entry.review?<AlertTriangle size={12}/>:actual?<ChevronRight size={13}/>:<span className="unavailable-dash">—</span>}</button>})}</div>
        <div className="coverage-note"><MapPin size={16}/><div><strong>Start with central Fremont</strong><span>{graph?`${covered} study entries in this area`:'Road snapshot awaiting import'}</span></div></div><div className="sidebar-footer"><Shield size={14}/> BUILT FOR LOCAL KNOWLEDGE</div>
      </aside>
      <main className="main-content"><div className="page-heading"><div><div className="eyebrow"><span className="lime-line"/> EXPLORE · LEVEL 01</div><h1>Your city. Your pace.</h1><p>Get to know Fremont, one street at a time.</p></div><div className="free-drive-badge"><span className="status-dot"/> FREE DRIVE<span>No timer. No pressure.</span></div></div>
        <div className="simulator-grid"><section className="map-section" ref={mapContainer}><div className="map-toolbar"><div><MapIcon size={17}/><strong>Central Fremont</strong><span className="surface-tag">SURFACE STREETS</span></div><button className="icon-button" aria-label="Expand map" onClick={()=>void toggleFullscreen()}>{fullscreen?<Minus size={17}/>:<Maximize2 size={17}/>}</button></div><div className="map-stage"><MapView graph={graph} vehicle={vehicle} labelMode={preferences.labelMode} highlightPriority={preferences.highlight} orientation={preferences.orientation} follow={follow} onFollowChange={setFollow} priorityNames={PRIORITY_NAMES} selectedRoad={selectedRoad} onMapReady={map=>{mapRef.current=map}}/>
          <div className="map-status"><span className={`status-dot ${graphStatus==='ready'?'':'amber'}`}/>{graphStatus==='ready'?'ROAD NETWORK VERIFIED':graphStatus==='loading'?'LOADING ROAD NETWORK':'ROAD NETWORK UNAVAILABLE'}</div>
          <div className="map-compass"><span>N</span><Navigation size={24} style={{transform:`rotate(${(preferences.orientation==='heading'?-(vehicle?.bearing||0):0)-45}deg)`}}/><span className="compass-cross">＋</span></div>
          <div className="map-controls"><button aria-label="Zoom in" onClick={()=>mapRef.current?.zoomIn()}><Plus size={20}/></button><button aria-label="Zoom out" onClick={()=>mapRef.current?.zoomOut()}><Minus size={20}/></button><div/><button aria-label="Recenter vehicle" className={follow?'selected':''} onClick={()=>{setFollow(true);if(vehicle)mapRef.current?.easeTo({center:vehicle.position,duration:400})}}><Crosshair size={20}/></button></div>
          {graphStatus!=='ready'&&<div className="network-overlay"><div className="network-card"><span className="network-icon"><MapPin size={27}/></span><h2>{graphStatus==='loading'?'Preparing your patrol area':'A real city needs real roads.'}</h2><p>{graphStatus==='loading'?'Loading and checking the Fremont road snapshot.':'The verified road snapshot is not available. Driving will be enabled after the actual Fremont network has been imported and validated.'}</p>{error&&<details><summary>Connection details</summary><p>{error}</p><code>npm run data:import</code></details>}{graphStatus==='error'&&<button className="primary-button" onClick={()=>void loadGraph()}><RotateCcw size={15}/> Retry road data</button>}</div></div>}
          {graph&&vehicle&&<div className="map-driving-state"><span className={`status-dot ${paused?'amber':''}`}/>{paused?'PAUSED · PRESS W TO DRIVE':vehicle.stoppedAtJunction?'CHOOSE A LEGAL TURN':'EXPLORING FREMONT'}<span>North {preferences.orientation==='north'?'up':'reference'}</span></div>}
        </div><div className="map-bottom"><div className="map-label-control"><Layers size={15}/><select aria-label="Map street labels" value={preferences.labelMode} onChange={e=>{update('labelMode',e.target.value as LabelMode);e.currentTarget.blur()}}><option value="all">All street names</option><option value="priority">Priority streets only</option><option value="none">No street names</option></select><ChevronDown size={12}/></div><button onClick={()=>update('highlight',!preferences.highlight)} className={preferences.highlight?'highlight-button enabled':'highlight-button'}><span className="mini-road"/>Priority roads <span className="toggle"><i/></span></button></div></section>
        <aside className="drive-panel"><div className="panel-heading"><span className="eyebrow">YOUR PATROL</span><span className="unit-id">UNIT 01</span></div><div className="street-label">CURRENT STREET</div><h2 className="current-street">{edge?shortName(edge.name||'Unnamed road'):'Ready to explore?'}</h2><div className="heading-display"><Navigation size={13} style={{transform:`rotate(${(vehicle?.bearing||0)-45}deg)`}}/>{vehicle?`${compass(vehicle.bearing)} · ${Math.round(vehicle.bearing)}°`:'Select a starting point'}<span className="heading-dot">•</span>Central Fremont</div>
          <div className="speed-gauge"><div className="gauge-arc"/><div className="gauge-number">{Math.round((vehicle?.speedMps||0)*2.23694)}<span>MPH</span></div><span className="speed-tick tick-left">0</span><span className="speed-tick tick-right">40</span><div className="gauge-status"><span className={`status-dot ${paused?'amber':''}`}/>{paused?'SIMULATION PAUSED':'ON PATROL'}</div></div>
          <div className="drive-action-row"><button className="primary-button" disabled={!graph} onClick={()=>setPaused(p=>!p)}>{paused?<Play size={15} fill="currentColor"/>:<Pause size={15}/>} {paused?'Begin drive':'Pause drive'}</button><button className="reset-button" disabled={!graph} onClick={()=>reset()} aria-label="Reset drive"><RotateCcw size={17}/></button></div>
          <div className="drive-divider"/><div className="section-label"><Route size={14}/> NEXT INTERSECTION</div><div className="next-street">{nextNames.length?nextNames.slice(0,2).map(n=>shortName(n!)).join(' / '):graph?'Follow the road ahead':'Waiting for road data'}</div><p className="junction-copy">{vehicle?.stoppedAtJunction?'Select a legal maneuver, then hold W.':'Select a turn before the intersection.'}</p><div className="turn-choices">{(['left','straight','right'] as const).map(type=>{const options=maneuverOptions.filter(m=>m.type===type);const Icon=type==='left'?ArrowLeft:type==='right'?ArrowRight:ArrowUp;return <button key={type} disabled={!options.length} className={options.some(m=>m.edgeId===vehicle?.queuedEdgeId)?'chosen':''} onClick={()=>selectDirection(type)}><Icon size={21}/><span>{type==='straight'?'Straight':type==='left'?'Left':'Right'}</span><kbd>{type==='left'?'A':type==='right'?'D':'↑'}</kbd></button>})}</div>{maneuverOptions.length>0&&<div className="legal-options">{maneuverOptions.map(m=><button key={m.edgeId} onClick={()=>choose(m.edgeId)} className={vehicle?.queuedEdgeId===m.edgeId?'selected':''}><span>{m.label}</span><ChevronRight size={13}/></button>)}</div>}
          <div className="drive-divider"/><label className="section-label" htmlFor="start-area"><Flag size={14}/> STARTING POINT</label><div className="select-wrapper"><select id="start-area" value={selectedStart} disabled={!graph} onChange={e=>{setSelectedStart(e.target.value);reset(e.target.value);e.currentTarget.blur()}}>{!starts.length&&<option>Central Fremont</option>}{starts.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><ChevronDown size={14}/></div><div className="session-info"><div><span>THIS DRIVE</span><strong>{(distance/1609.344).toFixed(2)} <small>mi explored</small></strong></div><Compass size={29}/></div>
        </aside></div>
        <div className="bottom-row"><div className="keyboard-guide"><div className="guide-title"><span className="keyboard-grid"><i/><i/><i/><i/></span><strong>You're in the driver's seat.</strong><span>Simple controls. Real streets.</span></div><div className="key-instructions"><span><kbd>W</kbd> / <kbd>↑</kbd> Accelerate</span><span><kbd>S</kbd> / <kbd>↓</kbd> Brake</span><span><kbd>A</kbd><kbd>D</kbd> Choose turn</span><span><kbd>SPACE</kbd> Pause</span><button onClick={()=>setHelp(true)}>All controls <ArrowUpRight size={13}/></button></div></div><div className="explore-tip"><Sparkles size={18}/><p><strong>Take the scenic route.</strong><span>There’s no destination. Familiarity is the goal.</span></p></div></div>
        <footer className="main-footer"><span>SIMULATED TRAINING ONLY <i/> Not an operational navigation tool</span><span><span className="status-dot"/>{graph?`${graph.edges.length.toLocaleString()} directed road segments`:'Milestones 01–02 · Development build'}<span className="footer-separator">|</span>© OpenStreetMap contributors</span></footer>
      </main>
    </div>
    {notice&&<div className="toast" role="status"><Check size={16}/>{notice}</div>}
    {(settings||help)&&<div className="modal-backdrop" onMouseDown={()=>{setSettings(false);setHelp(false)}}><section className="modal" role="dialog" aria-modal="true" aria-label={settings?'Drive settings':'Driving controls'} onMouseDown={e=>e.stopPropagation()}><button className="modal-close icon-button" aria-label="Close dialog" onClick={()=>{setSettings(false);setHelp(false)}}><X size={21}/></button><span className="eyebrow">MAKE IT YOUR DRIVE</span><h2>{settings?'Drive settings':'Your patrol controls'}</h2>{settings?<><label>Street names<select value={preferences.labelMode} onChange={e=>update('labelMode',e.target.value as LabelMode)}><option value="all">All streets visible</option><option value="priority">Priority streets only</option><option value="none">No street names</option></select></label><label>Map orientation<select value={preferences.orientation} onChange={e=>update('orientation',e.target.value as 'north'|'heading')}><option value="north">North up · recommended</option><option value="heading">Follow vehicle heading</option></select></label><label>Driving speed<select value={preferences.maxSpeed} onChange={e=>update('maxSpeed',Number(e.target.value))}><option value={8.94}>Relaxed · 20 mph</option><option value={13.4}>Standard · 30 mph</option><option value={17.88}>Brisk · 40 mph</option></select></label><label className="checkbox-setting"><input type="checkbox" checked={preferences.highlight} onChange={e=>update('highlight',e.target.checked)}/> Highlight priority roads</label><p className="modal-footnote">Settings are saved in this browser. Freeways and ramps are outside the current driving area.</p></>:<><div className="help-row"><kbd>W / ↑</kbd><span>Hold to accelerate. Release to coast.</span></div><div className="help-row"><kbd>S / ↓</kbd><span>Brake to a stop. Wrong-way reversing is disabled.</span></div><div className="help-row"><kbd>A / D</kbd><span>Queue a legal left or right turn. Use the road buttons at complex intersections.</span></div><div className="help-row"><kbd>SPACE</kbd><span>Pause or resume the simulation.</span></div><div className="help-row"><kbd>R</kbd><span>Reset to your selected starting point.</span></div><p className="modal-footnote">Continue straight when legal; otherwise the vehicle waits for your choice. Drag the map to explore and use recenter to follow your vehicle again.</p></>}<button className="primary-button" onClick={()=>{setSettings(false);setHelp(false)}}>Got it <Check size={16}/></button></section></div>}
  </div>
}
