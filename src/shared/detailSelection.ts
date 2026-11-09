/** Keep visible detailed neighborhoods selected until they leave the viewport.
 * The nearest ordering fills vacant slots, rather than displacing loaded detail
 * on every pan. Download/geometry budgets remain independent of presentation.
 */
export function selectDetailRegions(ordered:readonly number[],previous:ReadonlySet<number>,limit=24):Set<number> {
    const visible=new Set(ordered),selected=new Set<number>();
    for(const id of previous)if(visible.has(id)&&selected.size<limit)selected.add(id);
    for(const id of ordered){if(selected.size>=limit)break;selected.add(id);}
    return selected;
}
