import { useState, useSyncExternalStore, useEffect, useRef } from 'react';
import { ArrowDownToLine, ArrowUpRight, ChevronDown, CircleHelp, Crosshair, Github, Layers3, Loader2, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Pin, Scan, Search, SlidersHorizontal, X } from 'lucide-react';
import MapZoomSlider from './GUI/MapZoomSlider';
import PatternBrowser from './GUI/PatternBrowser';
import PinnedBitmaps from './GUI/PinnedBitmaps';
import type { MapControls, RenderingMode, ChunkDebugMode } from './map/MapControls';
import { metricAt, type BitmapInspection } from '@shared/mapAnalytics';
import { DEFAULT_RENDERING_MODE, DISPLAY_MODES, LAYER_PRESENTATION, isDisplayMetric as isMetric } from '@shared/layerPresentation';
import { paletteColors, paletteGradient, PARCEL_SIZE_COLORS } from './map/layers/ParcelSizeColors';
import './analytics.css';
import {siteBuild,developmentBuild} from './siteBuild';
import {mapStatus,pendingNeighborhoods,type MapStatus} from './shared/siteMetadata';

const MOBILE_LAYOUT='(max-width: 820px), (max-width: 1100px) and (max-height: 500px)';
const number=(v:number)=>new Intl.NumberFormat('en-US').format(v);
const compact=(v:number)=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(v);
const dateLabel=(value:string)=>new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(value))+' UTC';
function valueLabel(v:number,unit:string){
    if(unit==='share')return `${(v*100).toFixed(1)}%`;
    if(['bits','σ','ratio'].includes(unit))return `${v.toFixed(2)}${unit==='ratio'?'×':unit==='σ'?' σ':''}`;
    return number(Math.round(v));
}
const LAYERS=DISPLAY_MODES.map(id=>({id,...LAYER_PRESENTATION[id]}));
const PARCEL_CLASS_COLORS=paletteColors(PARCEL_SIZE_COLORS).map(c=>'#'+c.getHexString());
function BitmapLogo(){return <svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M2 2h12v12H2zM17 2h6v6h-6zM26 2h4v12h-4zM17 11h6v12h-6zM2 17h6v13H2zM11 17h3v6h-3zM11 26h12v4H11zM26 17h4v13h-4z"/></svg>;}

function Inspector({map,selection,busy,error,onClose,visible,pinned,onTogglePin}:{map:MapControls;selection?:BitmapInspection;busy:boolean;error:string;onClose:()=>void;visible:boolean;pinned:boolean;onTogglePin:()=>void}){
    const [matching,setMatching]=useState(false),[matchError,setMatchError]=useState('');
    const occupiedArea=selection?selection.histogram.reduce((sum,n,i)=>sum+n*(i+1)**2,0):1;
    const weightedSide=selection?selection.histogram.reduce((sum,n,i)=>sum+n*(i+1)**3,0)/occupiedArea:1;
    const max=selection?Math.max(...selection.histogram.map((n,i)=>n*(i+1)**2)):1;
    const exportBitmap=()=>{
        if(!selection)return;
        const rows=[['metric','value'],['bitmap',selection.id],['neighborhood',Math.floor(selection.id/2016)],['transactions',selection.count],['width',selection.width],['height',selection.height],['mean_side',selection.meanSize],['area_weighted_side',weightedSide],['occupancy',selection.occupancy],['diversity_bits',selection.diversity],['pattern',selection.pattern],['occurrences',selection.occurrences],...selection.histogram.map((n,i)=>['side_'+(i+1),n])];
        const url=URL.createObjectURL(new Blob([rows.map(r=>r.join(',')).join('\n')+'\n'],{type:'text/csv'}));
        const a=document.createElement('a');a.href=url;a.download=`bitmap-${selection.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    return <aside className="inspector panel" aria-label="Bitmap inspector" hidden={!visible}>
        <div className="panel-heading"><span><Crosshair size={14}/> BITMAP INSPECTOR</span><button className="icon-button" onClick={onClose} aria-label="Hide inspector"><X size={15}/></button></div>
        {busy&&<div className="inline-status" role="status"><Loader2 size={14} className="spin"/> Reading bitmap metrics…</div>}
        {error&&<p className="error-note" role="alert">{error}</p>}
        {!selection&&!busy?<div className="inspector-empty"><div className="crosshair-art"><Crosshair size={32} strokeWidth={1}/></div><h2>A closer look.</h2><p>Click a bitmap to inspect its geometry, transaction composition and pattern.</p><button className="text-action" onClick={()=>void map.goToBitmap(Math.min(840000,map.getState().publishedHeight))}>Explore bitmap #{number(Math.min(840000,map.getState().publishedHeight))}<ArrowUpRight size={14}/></button><div className="empty-hint"><Scan size={14}/><span>Zoom in to distinguish individual bitmaps.</span></div></div>:selection&&<>
            <div className="inspection-title"><span className="eyebrow">BITMAP / REGION {number(Math.floor(selection.id/2016))}</span><h2><span className="selectable-text">#{number(selection.id)}</span><span className="inspector-title-actions"><button className="icon-button" title="Focus bitmap" aria-label="Focus selected bitmap" onClick={()=>void map.goToBitmap(selection.id)}><Crosshair size={17}/></button><button className="icon-button pin-toggle" aria-label={pinned?'Unpin selected bitmap':'Pin selected bitmap'} title={pinned?'Unpin bitmap':'Pin bitmap'} aria-pressed={pinned} disabled={busy} onClick={onTogglePin}><Pin size={16}/></button></span></h2>
                {selection.occurrences>1?<div className="inspection-pattern"><div><span className="pattern-identity">Pattern #{number(selection.pattern)}</span><span className="pattern-occurrences">{number(selection.occurrences)} matching shapes</span></div><button className="small-button" aria-label="Filter this pattern" disabled={matching||busy} onClick={()=>{setMatching(true);setMatchError('');void map.findPatternMatches().catch(e=>setMatchError(String(e))).finally(()=>setMatching(false));}}>{matching?<Loader2 size={12} className="spin"/>:<SlidersHorizontal size={12}/>}Filter</button></div>:<span className="tag">Unique geometry</span>}
                {matchError&&<p className="error-note" role="alert">{matchError}</p>}
            </div>
            <dl className="metric-grid"><div><dt>Transactions</dt><dd>{number(selection.count)}</dd></div><div><dt>Rectangle area</dt><dd>{number(selection.width*selection.height)}<small> u²</small></dd></div><div><dt>Dimensions</dt><dd>{selection.width}<small> × </small>{selection.height}</dd></div><div><dt>Occupancy</dt><dd>{(selection.occupancy*100).toFixed(1)}<small>%</small></dd></div><div><dt>Area-weighted side</dt><dd>{weightedSide.toFixed(2)}</dd></div><div><dt>Size diversity</dt><dd>{selection.diversity.toFixed(2)}<small> bits</small></dd></div></dl>
            <div className="inspection-section"><div className="section-line"><h3>Parcel area by size</h3><span>{number(selection.count)} total</span></div><div className="composition-chart" role="img" aria-label="Parcel area by side-length class">{selection.histogram.map((n,i)=><div key={i} title={`Side ${i+1}: ${number(n)} parcels  · ${(n*(i+1)**2/occupiedArea*100).toFixed(1)}% of parcel area`}><span style={{height:`${n*(i+1)**2/Math.max(1,max)*100}%`,background:PARCEL_CLASS_COLORS[i]}}/><small>{i+1}</small></div>)}</div><p className="microcopy">Area-weighted classes · includes coinbase</p></div>
            <div className="inspection-actions"><button className="icon-button" aria-label="Export bitmap metrics as CSV" title="Export CSV" onClick={exportBitmap}><ArrowDownToLine size={15}/></button></div>
        </>}
    </aside>;
}

/** One layer selector, one configuration panel, and the canonical 2D map. */
export default function MapUI({map}:{map:MapControls}){
    const root=useRef<HTMLDivElement>(null);
    const state=useSyncExternalStore(map.subscribe,map.getState);
    const [dataStatus,setDataStatus]=useState<MapStatus>(),[fullscreenError,setFullscreenError]=useState('');
    const [query,setQuery]=useState(''),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
    const [requestedMode,setRequestedMode]=useState<RenderingMode>(DEFAULT_RENDERING_MODE);
    const [showInspector,setShowInspector]=useState(()=>!window.matchMedia(MOBILE_LAYOUT).matches),[help,setHelp]=useState(false),[full,setFull]=useState(false);
    const [showAnalysis,setShowAnalysis]=useState(false);
    const [pinned,setPinned]=useState<BitmapInspection[]>([]),[comparing,setComparing]=useState(false);
    const removePin=(id:number)=>{
        setPinned(items=>items.filter(item=>item.id!==id));
    };
    const togglePin=()=>{
        const selection=state.selection;if(!selection)return;
        setPinned(items=>items.some(item=>item.id===selection.id)?items.filter(item=>item.id!==selection.id):[...items,selection]);
    };
    useEffect(()=>{if(pinned.length<2)setComparing(false);},[pinned.length]);
    const comparePins=()=>{if(pinned.length>1)setComparing(true);};
    const focusPinned=async(id:number)=>{setShowInspector(true);await map.goToBitmap(id);};
    const summary=state.layerSummary,parcelMode=state.renderingMode==='size';
    const layer=LAYERS.find(layer=>layer.id===state.renderingMode)??{label:'Map geometry',description:'Canonical bitmap geometry.'};
    const unit=state.renderingMode==='area'?'u²':isMetric(state.renderingMode)?LAYER_PRESENTATION[state.renderingMode].unit:'';
    const palette=state.palette;
    const classColors=paletteColors(palette).map(c=>'#'+c.getHexString());
    const choose=(mode:RenderingMode)=>{setRequestedMode(mode);void map.setRenderingMode(mode).catch(()=>{});};
    useEffect(()=>{if(state.selection){setShowInspector(true);setShowAnalysis(false);}},[state.selection?.id]);
    useEffect(()=>{
        const mobile=window.matchMedia(MOBILE_LAYOUT);
        const resize=()=>{setShowAnalysis(false);if(mobile.matches){setShowInspector(false);setHelp(false);}};
        mobile.addEventListener('change',resize);
        return()=>mobile.removeEventListener('change',resize);
    },[]);
    useEffect(()=>{const listener=()=>setFull(!!document.fullscreenElement);listener();document.addEventListener('fullscreenchange',listener);return()=>document.removeEventListener('fullscreenchange',listener);},[]);
    useEffect(()=>{
        setDataStatus(undefined);if(!state.snapshot)return;
        const controller=new AbortController(),snapshot=state.snapshot,publishedHeight=state.publishedHeight;
        const refresh=()=>{void fetch(new URL('map-data/status.json',document.baseURI),{signal:controller.signal,cache:'no-store'})
            .then(r=>r.ok?r.json():undefined).then(value=>{const next=mapStatus(value,snapshot,publishedHeight);if(next&&!controller.signal.aborted)setDataStatus(next);}).catch(()=>{});};
        refresh();const timer=setInterval(refresh,60000);return()=>{controller.abort();clearInterval(timer);};
    },[state.snapshot,state.publishedHeight]);
    const toggleFullscreen=()=>{
        setFullscreenError('');
        const app=root.current?.parentElement;
        if(!app||!document.fullscreenEnabled){setFullscreenError('Fullscreen is unavailable in this browser.');return;}
        // Request from the click handler while browser user activation is valid.
        void (document.fullscreenElement?document.exitFullscreen():app.requestFullscreen({navigationUI:'hide'}))
            .catch(()=>setFullscreenError('Could not open fullscreen. Check this site’s browser permissions.'));
    };
    const search=async()=>{
        if(!/^\d+$/.test(query.trim())){setSearchError('Enter a block height.');return;}
        const id=Number(query);if(!Number.isSafeInteger(id)||id<0||id>state.publishedHeight){setSearchError(id>state.publishedHeight&&dataStatus?.syncedHeight!==null&&dataStatus?.syncedHeight!==undefined&&id<=dataStatus.syncedHeight?`Block ${number(id)} is synced but not on the map yet. Map coverage ends at ${number(state.publishedHeight)}.`:`Use a height from 0 to ${number(state.publishedHeight)}.`);return;}
        setSearching(true);setSearchError('');setShowAnalysis(false);setShowInspector(true);try{await map.goToBitmap(id);}catch(e){setSearchError(String(e));}finally{setSearching(false);}
    };
    const min=summary?metricAt(state.filter[0],summary):1,max=summary?metricAt(state.filter[1],summary):9;
    const distribution=state.parcelDistribution;
    const pending=dataStatus?.syncedHeight!=null?pendingNeighborhoods(state.publishedHeight,dataStatus.syncedHeight):undefined;
    return <div className={`atlas-ui${comparing&&pinned.length?' comparing-pins':''}`} ref={root}>
        <header className="atlas-header">
            <a className="brand" href="#" onClick={e=>{e.preventDefault();map.home();}} aria-label="Bitmap Explorer home"><span className="brand-symbol"><BitmapLogo/></span><span>bitmap<span className="brand-light"> explorer</span><small>BITCOIN / MAINNET</small></span></a>
            <form className="atlas-search" onSubmit={e=>{e.preventDefault();void search();}}><Search size={15}/><input aria-label="Search bitmap by block height" placeholder="Find a bitmap by block height…" inputMode="numeric" value={query} onChange={e=>{setQuery(e.target.value.replace(/\D/g,''));setSearchError('');}}/><button type="submit" disabled={!state.ready||searching} aria-label="Search bitmap">{searching?<Loader2 size={14} className="spin"/>:<span>↵</span>}</button>{searchError&&<div className="search-error" role="alert">{searchError}</div>}</form>
            <div className="header-actions"><button className="icon-button mobile-analysis-toggle" aria-label="Toggle map analysis" aria-expanded={showAnalysis} aria-controls="map-analysis" onClick={()=>{setShowAnalysis(!showAnalysis);setShowInspector(false);setHelp(false);}}><SlidersHorizontal size={18}/></button><button className="icon-button" aria-label="Toggle bitmap inspector" aria-pressed={showInspector} title={showInspector?'Hide bitmap inspector':'Show bitmap inspector'} onClick={()=>{setShowInspector(!showInspector);setShowAnalysis(false);setHelp(false);}}>{showInspector?<PanelRightClose size={18}/>:<PanelRightOpen size={18}/>}</button><button className="icon-button" aria-label="Keyboard and navigation help" onClick={()=>{setHelp(!help);setShowAnalysis(false);if(window.matchMedia(MOBILE_LAYOUT).matches)setShowInspector(false);}}><CircleHelp size={17}/></button><button className="icon-button" aria-label={full?'Exit fullscreen':'Enter fullscreen'} title={full?'Exit fullscreen (Esc)':'Enter fullscreen'} aria-pressed={full} onClick={toggleFullscreen}>{full?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button></div>
        </header>
        {fullscreenError&&<div className="fullscreen-error panel" role="alert"><span>{fullscreenError}</span><button className="icon-button" aria-label="Dismiss fullscreen error" onClick={()=>setFullscreenError('')}><X size={15}/></button></div>}
        {showAnalysis&&<button className="mobile-panel-backdrop" aria-label="Close map analysis" onClick={()=>setShowAnalysis(false)}/>}
        <aside id="map-analysis" className={`atlas-sidebar${showAnalysis?' analysis-open':''}${state.renderingMode==='patterns'?' patterns-sidebar':''}`} aria-label="Map analysis controls">
            <div className="mobile-panel-heading panel-heading"><span>Map analysis</span><button className="icon-button" aria-label="Close analysis panel" onClick={()=>setShowAnalysis(false)}><X size={18}/></button></div>
            {state.publishedHeight>=0&&<details className="data-status"><summary>Map through #{number(state.publishedHeight)}<ChevronDown size={13}/></summary><div className="coverage-details">
                <p>Only complete regions of 2,016 bitmaps appear on the map.</p>
                {dataStatus?.syncedHeight!=null&&<p>Synced through <strong>#{number(dataStatus.syncedHeight)}</strong>.</p>}
                {pending&&pending.unpublished>0&&<><p><strong>{number(pending.unpublished)}</strong> synced blocks are not on the map yet.</p>{pending.ready>0&&<p>{number(pending.ready)} complete {pending.ready===1?'region is':'regions are'} ready for generation.</p>}{pending.progress>0&&<p>Next region: <strong>{number(pending.progress)} / 2,016</strong>. Waiting for {number(pending.remaining)} more blocks.</p>}</>}
                {dataStatus?.generatedAt&&<p>Map data updated <time dateTime={dataStatus.generatedAt}>{dateLabel(dataStatus.generatedAt)}</time>.</p>}
                {dataStatus?.syncedAt&&<p>Last sync <time dateTime={dataStatus.syncedAt}>{dateLabel(dataStatus.syncedAt)}</time>.</p>}
            </div></details>}
            <section className="sidebar-section"><div className="section-line"><h2><Layers3 size={16}/> Map layer</h2></div>
                <label className="field-label layer-label" htmlFor="rendering-layer">Color by</label>
                <div className="select-wrap"><select id="rendering-layer" aria-label="Rendering" value={state.renderingMode} disabled={!state.ready||state.renderingBusy||!state.renderingAvailable} onChange={e=>choose(e.target.value as RenderingMode)}>{state.renderingMode==='default'&&<option value="default" disabled>Map geometry</option>}{LAYERS.map(layer=><option key={layer.id} value={layer.id}>{layer.label}</option>)}</select><ChevronDown size={14}/></div>
                <details className="layer-notes"><summary>About this layer <ChevronDown size={14}/></summary><p className="layer-description">{layer.description}</p>{state.renderingMode!=='patterns'&&<p className="microcopy">Color shows the matching mean; intensity shows concentration.</p>}</details>
                {state.renderingBusy&&<p className="inline-status" role="status"><Loader2 size={13} className="spin"/> Loading layer…</p>}
                {state.renderingError&&<div className="error-note" role="alert">{state.renderingError}<button className="text-action" onClick={()=>choose(requestedMode)}>Retry layer</button></div>}
            </section>
            <section className="sidebar-section legend-section" aria-label="Layer legend"><div className="section-line"><h2><SlidersHorizontal size={16}/> Filters</h2>{summary&&<span className="tag">{summary.scale.toUpperCase()}</span>}{parcelMode&&<span className="tag">AREA WEIGHTED</span>}</div>
                {state.renderingMode==='patterns'?<PatternBrowser map={map} state={state}/>:state.matchedPattern!==undefined?<><p className="match-note">Exact matches for pattern #{number(state.matchedPattern)}</p><p className="microcopy">Orange regions contain matches. Zoom in for exact bitmap membership.</p><button className="text-action" onClick={()=>choose(state.renderingMode)}>Clear pattern highlight <X size={12}/></button></>:<>
                    <div className="legend-gradient" style={{background:state.renderingMode==='default'?'#f5a340':paletteGradient(palette)}}/>
                    <div className="legend-labels"><span>{parcelMode?'Side 1 · smaller':summary?valueLabel(summary.min,unit):'Bitmap geometry'}</span><span>{parcelMode?'Side 9 · larger':summary?valueLabel(summary.max,unit):'Orange / graphite'}</span></div>
                    {parcelMode&&distribution&&<>
                        <div className="parcel-distribution" role="group" aria-label="Parcel area distribution by size">{distribution.areas.map((area,i)=><button key={i} title={`Side ${i+1}: ${number(distribution.counts[i])} parcels · ${(area/distribution.areas.reduce((a,b)=>a+b,0)*100).toFixed(2)}% of parcel area`} aria-label={`Filter parcel side ${i+1}`} aria-pressed={i+1>=state.parcelRange[0]&&i+1<=state.parcelRange[1]} onClick={()=>void map.setParcelRange(i+1,i+1)}><span style={{height:`${area/Math.max(1,...distribution.areas)*100}%`,background:classColors[i]}}/><small>{i+1}</small></button>)}</div>
                        <div className="section-line chart-caption"><span>Parcel area by side length</span></div>
                        <div className="parcel-presets" role="group" aria-label="Parcel size presets">{([{label:'All',low:1,high:9},{label:'Small',low:1,high:3},{label:'Medium',low:4,high:6},{label:'Large',low:7,high:9}] as const).map(preset=><button key={preset.label} aria-pressed={state.parcelRange[0]===preset.low&&state.parcelRange[1]===preset.high} onClick={()=>void map.setParcelRange(preset.low,preset.high)}>{preset.label}</button>)}</div>
                        <div className="filter-heading"><span>Parcel side range</span><button className="text-action" onClick={()=>void map.setParcelRange(1,9)}>Reset</button></div>
                        <div className="range-values"><span>Side {state.parcelRange[0]}</span><span>Side {state.parcelRange[1]}</span></div>
                        <div className="filter-sliders"><input type="range" min="1" max="9" step="1" aria-label="Minimum parcel side" value={state.parcelRange[0]} onChange={e=>void map.setParcelRange(Math.min(Number(e.target.value),state.parcelRange[1]),state.parcelRange[1])}/><input type="range" min="1" max="9" step="1" aria-label="Maximum parcel side" value={state.parcelRange[1]} onChange={e=>void map.setParcelRange(state.parcelRange[0],Math.max(state.parcelRange[0],Number(e.target.value)))}/></div>
                        <div className="filter-result"><i/>{state.filterBusy?'Updating selection…':`${compact(state.parcelMatches??0)} parcels · ${number(state.filterMatches??0)} bitmaps`}</div>
                        <p className="microcopy">{((state.parcelAreaShare??1)*100).toFixed(2)}% of parcel area selected.</p>
                    </>}
                    {summary&&<><div className="distribution-chart" aria-label="Bitmap distribution; select a bin to filter">{summary.histogram.map((n,i)=><button key={i} aria-label={`Filter bin ${i+1}: ${number(n)} bitmaps`} title={`${valueLabel(metricAt(i/32,summary),unit)} – ${valueLabel(metricAt((i+1)/32,summary),unit)} · ${number(n)} bitmaps`} onClick={()=>map.setMetricFilter(i/32,(i+1)/32)} className={(i+.5)/32>=state.filter[0]&&(i+.5)/32<=state.filter[1]?'included':''} style={{height:`${Math.log1p(n)/Math.log1p(Math.max(1,...summary.histogram))*100}%`}}/>)}</div><div className="section-line chart-caption"><span>Bitmaps · log frequency</span></div>
                        <div className="filter-heading"><span>Highlight range{unit==='u²'?' (u²)':''}</span><button className="text-action" onClick={()=>map.setMetricFilter(0,1)}>Reset</button></div><div className="range-values"><span>{valueLabel(min,unit)}</span><span>{valueLabel(max,unit)}</span></div><div className="filter-sliders"><input type="range" min="0" max="1" step="0.001" aria-label="Minimum metric value" value={state.filter[0]} onChange={e=>map.setMetricFilter(Math.min(Number(e.target.value),state.filter[1]),state.filter[1])}/><input type="range" min="0" max="1" step="0.001" aria-label="Maximum metric value" value={state.filter[1]} onChange={e=>map.setMetricFilter(state.filter[0],Math.max(state.filter[0],Number(e.target.value)))}/></div>
                        <div className="filter-result"><i/>{state.filterBusy?'Updating selection…':`${number(state.filterMatches??state.analytics?.count??0)} matching bitmaps`}</div><p className="microcopy">Gray = no matches. Zoom in for details.</p>
                    </>}
                    {state.renderingMode==='default'&&<p className="microcopy">Choose a layer to configure its distribution and highlight range.</p>}
                </>}
                {state.renderingMode!=='default'&&state.renderingMode!=='patterns'&&state.matchedPattern===undefined&&<details className="palette-settings"><summary>Customize palette <ChevronDown size={12}/></summary><div className="palette-swatches">{palette.map((color,i)=><input key={i} type="color" aria-label={state.renderingMode==='count'?['Low transaction count color','Medium transaction count color','High transaction count color'][i]:state.renderingMode==='area'?['Minimum area color','Middle area color','Maximum area color'][i]:state.renderingMode==='size'?`Size ${1+i*4} color`:`${['Low','Medium','High'][i]} ${layer.label.toLowerCase()} color`} title={`Color ${i+1}`} value={color} onChange={e=>{const colors=[...palette];colors[i]=e.target.value;map.setPalette(colors);}}/>)}</div><button className="text-action" onClick={()=>map.setPalette(state.renderingMode==='default'?PARCEL_SIZE_COLORS:LAYER_PRESENTATION[state.renderingMode].colors)}>Restore palette</button></details>}
            </section>
        </aside>
        <div className="map-context"><span className="context-line" aria-hidden="true"/><strong>{layer.label}{state.matchedPattern!==undefined?' · pattern matches':''}</strong></div>
        <Inspector pinned={!!state.selection&&pinned.some(item=>item.id===state.selection!.id)} onTogglePin={togglePin} visible={showInspector} map={map} selection={state.selection} busy={state.inspectionBusy} error={state.inspectionError} onClose={()=>setShowInspector(false)}/>
        <PinnedBitmaps items={pinned} comparing={comparing} selected={state.selection?.id} onCompare={comparePins} onClose={()=>setComparing(false)} onRemovePin={removePin} onFocus={focusPinned}/>
        {state.ready&&<MapZoomSlider map={map}/>}
        {!state.ready&&<div className="map-loading"><Loader2 className="spin" size={20}/><span>Loading the map…</span><small>{state.status||'Loading authenticated map geometry'}</small></div>}
        {help&&<div className="help-panel panel"><div className="panel-heading"><span>Navigation</span><button className="icon-button" aria-label="Close help" onClick={()=>setHelp(false)}><X size={14}/></button></div><dl><dt>Drag</dt><dd>Pan the map</dd><dt>Pinch</dt><dd>Zoom · release to snap to a level</dd><dt>One finger</dt><dd>Pan · tap a bitmap to inspect</dd><dt>Mouse wheel</dt><dd>Zoom at the cursor</dd><dt>Middle drag</dt><dd>Zoom at the starting point</dd><dt>Click bitmap</dt><dd>Inspect its metrics</dd><dt>Home</dt><dd>Return to genesis</dd><dt>Histogram bin</dt><dd>Highlight a range</dd></dl>{state.chunkDebugEnabled&&<details className="debug-settings"><summary>Geometry diagnostics <ChevronDown size={14}/></summary><label className="field-label" htmlFor="map-chunk-debug">Chunk outlines</label><select id="map-chunk-debug" aria-label="Chunk outlines" value={state.chunkDebugMode} onChange={e=>map.setChunkDebug(e.target.value as ChunkDebugMode)}><option value="none">None</option><option value="all">All</option><option value="parcels">Parcel chunks</option><option value="bitmaps">Bitmap chunks</option><option value="heatmap">Heatmap tiles</option></select></details>}</div>}
        <footer className="atlas-footer">
            <div className="build-metadata"><span className="build-version">v{siteBuild.version}{developmentBuild?' · dev':''}</span>{siteBuild.builtAt?<time dateTime={siteBuild.builtAt} title="Application build time; map coverage and sync dates are listed in the sidebar.">{dateLabel(siteBuild.builtAt)}</time>:<span>Development build</span>}</div>
            <dl className="footer-totals" aria-label="Dataset totals">
                <div><dt>Bitmaps</dt><dd>{state.publishedHeight>=0?number(state.publishedHeight+1):'—'}</dd></div>
                <div><dt>Parcels</dt><dd>{state.publishedParcels!==undefined?number(state.publishedParcels):'—'}</dd></div>
                <div><dt>Regions</dt><dd>{state.neighborhoods?number(state.neighborhoods):'—'}</dd></div>
            </dl>
            <div className="footer-links"><a href="https://twitter.com/bitlodo" target="_blank" rel="noopener noreferrer">by @bitlodo</a><span className="footer-divider"/>fork on <a href="https://github.com/bitlodo/explorer" target="_blank" rel="noopener noreferrer"><Github size={13}/>GitHub</a></div>
        </footer>
    </div>;
}
