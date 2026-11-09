import {useState} from 'react';
import {Columns3,X} from 'lucide-react';
import type {BitmapInspection} from '../shared/mapAnalytics';

type Props={
    items:readonly BitmapInspection[];comparing:boolean;selected?:number;
    onCompare:()=>void;onClose:()=>void;onRemovePin:(id:number)=>void;
    onFocus:(id:number)=>Promise<void>;
};
const number=(value:number)=>value.toLocaleString('en-US');
function metrics(item:BitmapInspection){
    const occupied=item.histogram.reduce((sum,count,i)=>sum+count*(i+1)**2,0);
    const side=item.histogram.reduce((sum,count,i)=>sum+count*(i+1)**3,0)/occupied;
    return [['Transactions',number(item.count)],['Rectangle area',`${number(item.width*item.height)} u²`],['Dimensions',`${item.width} × ${item.height}`],['Occupancy',`${(item.occupancy*100).toFixed(1)}%`],['Weighted side',side.toFixed(2)],['Size diversity',`${item.diversity.toFixed(2)} bits`]];
}

/** Pins and comparison columns stay in React; navigation uses only MapControls. */
export default function PinnedBitmaps({items,comparing,selected,onCompare,onClose,onRemovePin,onFocus}:Props){
    const [error,setError]=useState('');
    const focus=(id:number)=>{setError('');void onFocus(id).catch(reason=>setError(String(reason)));};
    if(!items.length)return null;
    if(!comparing)return <aside className="pinned-list panel" aria-label="Pinned bitmaps">
        <div className="pinned-items">{items.map(item=><div className="pinned-item" key={item.id}>
            <button className="pinned-focus" aria-label={`Focus pinned bitmap ${item.id}`} aria-pressed={selected===item.id} onClick={()=>focus(item.id)}><strong>#{number(item.id)}</strong><span>{number(item.count)} TX</span></button>
            <button className="icon-button pin-remove" aria-label={`Unpin bitmap ${item.id}`} title="Unpin bitmap" onClick={()=>onRemovePin(item.id)}><X size={13}/></button>
        </div>)}</div>
        {items.length>1&&<div className="pinned-list-actions"><button className="text-action" onClick={onCompare}><Columns3 size={14}/>Compare pinned</button><span className="tag">{items.length}</span></div>}
        {error&&<p className="pinned-error" role="alert">{error}</p>}
    </aside>;
    return <section className="pinned-comparison panel" aria-label="Pinned comparison">
        <div className="comparison-heading"><span><Columns3 size={14}/>Compare pinned <small>{items.length}</small></span><div>
            <button className="icon-button" aria-label="Close pinned comparison" title="Close comparison" onClick={onClose}><X size={15}/></button>
        </div></div>
        {error&&<p className="pinned-error" role="alert">{error}</p>}
        <div className="comparison-scroll" tabIndex={0} aria-label="Compared bitmaps">
            {items.map(item=><article className="comparison-card" key={item.id} data-bitmap={item.id}>
                <div className="comparison-card-heading"><button className="text-action" aria-label={`Focus compared bitmap ${item.id}`} onClick={()=>focus(item.id)}>#{number(item.id)}</button><div>
                    <button className="icon-button pin-remove" aria-label={`Unpin bitmap ${item.id}`} title="Remove pin and comparison" onClick={()=>onRemovePin(item.id)}><X size={13}/></button>
                </div></div>
                <dl>{metrics(item).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </article>)}
        </div>
    </section>;
}
