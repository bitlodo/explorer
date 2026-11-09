import {useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {MapControls,MapSnapshot} from '../map/MapControls';
import type {PatternEntry} from '../shared/patterns';
import {PARCEL_SIZE_COLORS,paletteColors} from '../map/layers/ParcelSizeColors';

const number=(value:number)=>value.toLocaleString('en-US');
const ROW_HEIGHT=80,PAGE_SIZE=12;
const parcelColors=paletteColors(PARCEL_SIZE_COLORS).map(color=>'#'+color.getHexString());
function Preview({entry,map}:{entry:PatternEntry;map:MapControls}){
    const canvas=useRef<HTMLCanvasElement>(null);
    const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[attempt,setAttempt]=useState(0);
    useEffect(()=>{
        const controller=new AbortController();setStatus('loading');
        void map.getPatternPreview(entry.id,controller.signal).then(preview=>{
            if(controller.signal.aborted||!canvas.current)return;
            const context=canvas.current.getContext('2d');if(!context)return;
            context.clearRect(0,0,128,128);
            const scale=Math.min(112/preview.width,112/preview.height),x=(128-preview.width*scale)/2,y=(128-preview.height*scale)/2;
            for(let i=0;i<preview.rects.length;i+=4){
                const [left,top,width,height]=preview.rects.subarray(i,i+4);
                context.fillStyle=parcelColors[Math.min(8,Math.max(0,width-1))];
                const gap=Math.min(.8,scale*.15);context.fillRect(x+left*scale,y+top*scale,Math.max(.2,width*scale-gap),Math.max(.2,height*scale-gap));
            }
            setStatus('ready');
        }).catch(()=>{if(!controller.signal.aborted)setStatus('error');});
        return()=>controller.abort();
    },[entry.id,map,attempt]);
    return <span className="pattern-thumbnail"><canvas ref={canvas} width={128} height={128} aria-label={`Canonical parcel geometry for pattern ${entry.id}`} style={{visibility:status==='ready'?'visible':'hidden'}}/>{status==='loading'&&<span className="microcopy">Loading…</span>}{status==='error'&&<span role="button" tabIndex={0} className="text-action" onClick={event=>{event.stopPropagation();setAttempt(value=>value+1);}} onKeyDown={event=>{if(event.key==='Enter'){event.stopPropagation();setAttempt(value=>value+1);}}}>Retry</span>}</span>;
}

/** Pages append on scroll; only nearby rows mount canvases and request geometry. */
export default function PatternBrowser({map,state}:{map:MapControls;state:MapSnapshot}){
    const list=useRef<HTMLDivElement>(null),[entries,setEntries]=useState<PatternEntry[]>([]),[total,setTotal]=useState(0),[scrollTop,setScrollTop]=useState(0);
    const [custom,setCustom]=useState(false),[customCount,setCustomCount]=useState(''),[viewHeight,setViewHeight]=useState(320);
    useEffect(()=>{
        const element=list.current;if(!element)return;
        const observer=new ResizeObserver(()=>setViewHeight(element.clientHeight));observer.observe(element);
        return()=>observer.disconnect();
    },[]);
    const transactions=state.patternTransactions,groups=state.patternGroups??[];
    useEffect(()=>{if(transactions===undefined){setCustom(false);setCustomCount('');}},[transactions]);
    useEffect(()=>{
        const page=map.getPatternPage(transactions,0,PAGE_SIZE);setEntries(page.entries);setTotal(page.total);setScrollTop(0);
        if(list.current)list.current.scrollTop=0;
    },[map,transactions,state.patternTotal]);
    useEffect(()=>{
        if(entries.length&&entries.length<total&&entries.length*ROW_HEIGHT<viewHeight+ROW_HEIGHT){
            setEntries(current=>[...current,...map.getPatternPage(transactions,current.length,PAGE_SIZE).entries]);
        }
    },[map,transactions,entries.length,total,viewHeight]);
    const start=Math.max(0,Math.min(entries.length-1,Math.floor(scrollTop/ROW_HEIGHT)-2)),end=Math.min(entries.length,Math.ceil((scrollTop+viewHeight)/ROW_HEIGHT)+2);
    const customValue=custom||transactions!==undefined&&!groups.some(group=>group.transactions===transactions);
    return <div className="patterns-browser">
        <label className="field-label" htmlFor="pattern-transactions">Transaction count</label>
        <div className="select-wrap"><select id="pattern-transactions" value={customValue?'custom':transactions??'all'} disabled={state.renderingBusy} onChange={event=>{
            const value=event.target.value;setCustom(value==='custom');if(value==='custom')setCustomCount(transactions?.toString()??'');
            if(value!=='custom'){setCustomCount('');void map.setPatternFilter(value==='all'?undefined:Number(value));}
        }}>
            <option value="all">All · {number(state.patternTotal??0)} patterns</option>
            {groups.map(group=><option key={group.transactions} value={group.transactions}>{number(group.transactions)} TX · {number(group.patterns)} patterns</option>)}
            <option value="custom">Custom count…</option>
        </select><ChevronDown size={14}/></div>
        {customValue&&<input className="pattern-custom-count" type="number" min={1} max={262144} step={1} aria-label="Exact transaction count" placeholder="Exact TX count" value={custom?customCount:transactions??''} onChange={event=>{setCustom(true);setCustomCount(event.target.value);const value=Number(event.target.value);if(Number.isSafeInteger(value)&&value>=1&&value<=262144)void map.setPatternFilter(value);}}/>}
        <div className="pattern-results"><span>{number(total)} patterns</span><button className="text-action" onClick={()=>{setCustom(false);setCustomCount('');void map.setPatternFilter();}}>Reset</button></div>
        {state.selectedPattern!==undefined&&<p className="microcopy">Pattern #{number(state.selectedPattern)}</p>}
        {state.selectedPattern!==undefined&&<button className="text-action pattern-clear" onClick={()=>void map.setPatternFilter(transactions)}>Clear pattern</button>}
        <div className="filter-result" role="status"><i/>{state.filterBusy?'Updating selection…':`${number(state.filterMatches??0)} matches`}</div>
        <div className="pattern-list" ref={list} role="group" aria-label="Pattern previews" onScroll={event=>{
            const element=event.currentTarget;setScrollTop(element.scrollTop);
            if(element.scrollHeight-element.scrollTop-element.clientHeight<224&&entries.length<total){
                setEntries(current=>[...current,...map.getPatternPage(transactions,current.length,PAGE_SIZE).entries]);
            }
        }}>
            <div style={{height:start*ROW_HEIGHT}}/>
            {entries.slice(start,end).map(entry=><button key={entry.id} className="pattern-card" aria-label={`Pattern ${entry.id}: ${entry.transactions} transactions, ${entry.occurrences} bitmaps`} aria-pressed={state.selectedPattern===entry.id} onClick={()=>void map.setPatternFilter(transactions,state.selectedPattern===entry.id?undefined:entry.id)}>
                <Preview entry={entry} map={map}/><span className="pattern-card-info"><strong>#{number(entry.id)}</strong><span>{number(entry.transactions)} TX</span><span>{number(entry.occurrences)} bitmaps</span></span>
            </button>)}
            <div style={{height:Math.max(0,(entries.length-end)*ROW_HEIGHT)}}/>
            {total===0&&<p className="microcopy pattern-empty">No repeated patterns. Unique matches remain visible.</p>}
        </div>
    </div>;
}
