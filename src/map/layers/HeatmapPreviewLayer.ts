import type { Lod4Metric } from '@shared/lod4Summary';
import SpatialLod4Layer from './SpatialLod4Layer';
import SpatialSummaryLayer from './SpatialSummaryLayer';
import * as THREE from 'three';
import {colorUniforms,sizeColorGLSL,setColors,PARCEL_SIZE_COLORS} from './ParcelSizeColors';
import type {MapDataSource} from '@/data/MapDataSource';
import {previewKey,detailLayers,type PreviewIndex,type PreviewTileRef} from '@shared/heatmapPreview';
import type {NeighborhoodSlot,NeighborhoodRect} from '@shared/NeighborhoodLayout';
import type { RegionStyle } from '@shared/layerPresentation';
import type {RegionSummaries} from '@shared/analyticalLod';
import {queueAttributeUpdateRange} from './attributeUpdates';
import AnalyticalRegionPreviewLayer, {type PreviewGeometryCoverage} from './AnalyticalRegionPreviewLayer';
type Bounds={x:number;y:number;width:number;height:number};
type Patch={bounds:Bounds;first:number;count:number;coverage:number};
type Tile={coverageRevision?:number;patches:Patch[];ref:PreviewTileRef;mesh:THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;texture:THREE.DataTexture;used:number};
/** Hosts analytical region summaries and supported fixed-world raster previews. */
export default class HeatmapPreviewLayer extends THREE.Group {
    private spatial?:SpatialLod4Layer|SpatialSummaryLayer;
    private spatialBlend=0;
    private spatialDownloads=false;
    private spatialPixels=1;
    private spatialBounds?:Bounds;
    private regional?:AnalyticalRegionPreviewLayer;
    get analyticalPolicy(){return this.regional?.policy;}
    setRegionSummaries(summaries:RegionSummaries|undefined,style:RegionStyle='share'){
        if(!summaries){this.regional?.dispose();this.regional=undefined;this.spatial?.dispose();this.spatial=undefined;this.changed();return;}
        if(this.regional)this.regional.setSummaries(summaries);
        else{
            this.revision++;for(const controller of this.loads.values())controller.abort();this.loads.clear();
            for(const tile of this.tiles.values()){tile.texture.dispose();tile.mesh.geometry.dispose();tile.mesh.material.dispose();tile.mesh.removeFromParent();}
            this.tiles.clear();this.wanted.clear();this.stats.tiles=0;this.stats.textureBytes=0;
            this.regional=new AnalyticalRegionPreviewLayer(this.slots,summaries);this.add(this.regional);
        }
        if(!this.spatial&&this.source.getLod4Index){this.spatial=this.source.getLod4SummaryIndex&&this.source.getLod4SummaryBatch?new SpatialSummaryLayer(this.source,this.slots,this.changed,this.report):new SpatialLod4Layer(this.source,this.slots,this.changed,this.report);this.add(this.spatial);this.spatial.setColors(this.colors);}
        this.spatial?.setSummaries(summaries);
        this.regional.setRegionStyle(style);this.regional.setColors(this.colors);if(this.edges)this.edges.visible=false;this.changed();
    }
    setSpatialMetric(metric:Lod4Metric){this.spatial?.setMetric(metric);}
    setSpatialView(blend:number,pixels:number,bounds:Bounds,downloadsAllowed=false){this.spatialBlend=blend;this.spatialPixels=pixels;this.spatialBounds=bounds;this.spatialDownloads=downloadsAllowed;}
    get spatialStats(){return this.spatial?.stats;}
    get aggregateOverviews(){return this.spatial instanceof SpatialSummaryLayer&&this.spatial.aggregateOverviews;}
    private parcelClassMode=false;
    private parcelRange=[1,9];
    private get tileCapacity(){return Math.floor(64/(this.index?.channels??1));}
    private analyticMode=false;
    private filterRange=[1,9];
    private heatmapMode=false;
    private sizeColorMode=false;
    private areaColorMode=false;
    private areaMax=145908;
    private areaMin=1;
    private areaLog=false;
    private colors:readonly string[]=PARCEL_SIZE_COLORS;
    private revision=0;
    private index?:PreviewIndex;
    private refs=new Map<string,PreviewTileRef>();
    private levels=new Map<number,PreviewTileRef[]>();
    private minimumLevel=0;
    private coverageCellSize=0;
    private tiles=new Map<string,Tile>();
    private wanted=new Set<string>();
    private loads=new Map<string,AbortController>();
    private failures=new Map<string,number>();
    private edges?:THREE.LineSegments<THREE.BufferGeometry,THREE.LineBasicMaterial>;
    private active=true;
    private disposed=false;
    private priorities=new Map<string,number>();
    private projectedBounds=new Map<string,Bounds[]>();
    readonly stats={requests:0,loaded:0,level:-1,tiles:0,textureBytes:0};
    constructor(private source:MapDataSource,private slots:readonly NeighborhoodSlot[],private changed:()=>void,private report:(error:unknown)=>void,private sourceSlots?:readonly NeighborhoodRect[]){
        super();this.name='heatmap-preview-pyramid';this.setLayout(slots);
        void source.getPreviewIndex?.().then(index=>{if(this.disposed||this.revision)return;if(index)this.setIndex(index);}).catch(report);
    }
    setIndex(index:PreviewIndex){
        this.revision++;for(const c of this.loads.values())c.abort();this.loads.clear();
        for(const t of this.tiles.values()){t.texture.dispose();t.mesh.geometry.dispose();t.mesh.material.dispose();t.mesh.removeFromParent();}
        this.tiles.clear();this.refs.clear();this.levels.clear();this.failures.clear();this.wanted.clear();this.index=index;this.projectedBounds.clear();
        for(const ref of index.tiles){this.refs.set(previewKey(ref.level,ref.x,ref.y),ref);const list=this.levels.get(ref.level)||[];list.push(ref);this.levels.set(ref.level,list);}this.changed();
    }
    setParcelClasses(enabled:boolean,low=1,high=9){this.parcelClassMode=enabled;this.parcelRange=[low,high];for(const t of this.tiles.values()){t.mesh.material.uniforms.parcelClassMode.value=enabled?1:0;t.mesh.material.uniforms.parcelMin.value=low;t.mesh.material.uniforms.parcelMax.value=high;}}
    setAnalytic(enabled:boolean,low=1,high=9){this.analyticMode=enabled;this.filterRange=[low,high];for(const t of this.tiles.values()){t.mesh.material.uniforms.metricEnabled.value=enabled?1:0;t.mesh.material.uniforms.filterMin.value=low;t.mesh.material.uniforms.filterMax.value=high;}}
    setHeatmap(enabled:boolean){this.heatmapMode=enabled;for(const t of this.tiles.values())t.mesh.material.uniforms.heatmapEnabled.value=enabled?1:0;}
    setBitmapAreaMode(enabled:boolean,maxArea=145908,minArea=1,logarithmic=false){this.areaLog=logarithmic;this.areaColorMode=enabled;this.areaMax=maxArea;this.areaMin=minArea;for(const t of this.tiles.values()){t.mesh.material.uniforms.bitmapAreaLog.value=logarithmic?1:0;t.mesh.material.uniforms.bitmapAreaMax.value=maxArea;t.mesh.material.uniforms.bitmapAreaMin.value=minArea;t.mesh.material.uniforms.sizeColorMode.value=enabled?2:(this.sizeColorMode?1:0);}}
    setSizeColorMode(enabled:boolean){this.sizeColorMode=enabled;this.areaColorMode=false;for(const t of this.tiles.values())t.mesh.material.uniforms.sizeColorMode.value=enabled?1:0;}
    setSizeColors(colors:readonly string[]){this.colors=colors;this.regional?.setColors(colors);this.spatial?.setColors(colors);for(const t of this.tiles.values())setColors(t.mesh.material.uniforms,colors);}
    setLayout(slots:readonly NeighborhoodSlot[]){
        this.slots=slots;
        this.regional?.setLayout(slots);this.spatial?.setLayout(slots);
        this.projectedBounds.clear();
        this.edges?.geometry.dispose();this.edges?.material.dispose();this.edges?.removeFromParent();
        const points:number[]=[];
        for(const r of slots){const x=r.x,y=r.y,right=x+r.width,bottom=y+r.height;points.push(x,.025,y,right,.025,y,right,.025,y,right,.025,bottom,right,.025,bottom,x,.025,bottom,x,.025,bottom,x,.025,y);}
        const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
        this.edges=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:'#17191d',transparent:true,opacity:0,depthTest:false,depthWrite:false}));this.edges.renderOrder=.9;this.edges.frustumCulled=false;this.add(this.edges);
        if(this.index)for(const tile of this.tiles.values())this.rebuildTile(tile);
    }
    private rebuildTile(tile:Tile){
        tile.mesh.geometry.dispose();
        const {geometry,patches}=this.tileGeometry(tile.ref);tile.mesh.geometry=geometry;tile.patches=patches;tile.coverageRevision=undefined;
    }
    private tileGeometry(ref:PreviewTileRef){
        const size=this.index!.tileSize*2**ref.level,x=ref.x*size,y=ref.y*size,positions:number[]=[],uvs:number[]=[],indices:number[]=[],patches:Patch[]=[];
        const cell=this.coverageCellSize;
        for(const [id,r] of this.slots.entries()){
            const source=this.sourceSlots?.[id]??r,dx=r.x-source.x,dy=r.y-source.y;
            const left=Math.max(x,source.x)+dx,top=Math.max(y,source.y)+dy,right=Math.min(x+size,source.x+source.width)+dx,bottom=Math.min(y+size,source.y+source.height)+dy;if(right<=left||bottom<=top)continue;
            // Fixed world-space pieces share the original texture/material/draw.
            // Their coverage never depends on which part the camera can see.
            const firstX=cell?Math.floor(left/cell):0,lastX=cell?Math.ceil(right/cell)-1:0;
            const firstY=cell?Math.floor(top/cell):0,lastY=cell?Math.ceil(bottom/cell)-1:0;
            for(let row=firstY;row<=lastY;row++)for(let col=firstX;col<=lastX;col++){
                const l=cell?Math.max(left,col*cell):left,t=cell?Math.max(top,row*cell):top;
                const rr=cell?Math.min(right,(col+1)*cell):right,bb=cell?Math.min(bottom,(row+1)*cell):bottom;
                const a=(l-x)/size,b=(t-y)/size,c=(rr-x)/size,d=(bb-y)/size,i=positions.length/3;
                positions.push(a,0,b,c,0,b,a,0,d,c,0,d);
                // UVs stay in the stored tile; each neighborhood's vertices
                // move by its own translation, sharing the original texture.
                const u=dx/size,v=dy/size;uvs.push(a-u,b-v,c-u,b-v,a-u,d-v,c-u,d-v);indices.push(i,i+2,i+1,i+2,i+3,i+1);
                patches.push({bounds:{x:l,y:t,width:rr-l,height:bb-t},first:i,count:4,coverage:0});
            }
        }
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);
        const coverage=new THREE.BufferAttribute(new Float32Array(positions.length/3),1).setUsage(THREE.DynamicDrawUsage);
        coverage.onUpload(()=>coverage.clearUpdateRanges());geometry.setAttribute('geometryCoverage',coverage);
        return {geometry,patches};
    }
    get ready(){return !!this.index;}
    get rootsReady(){if(!this.index)return false;if(this.regional)return true;return this.index.tiles.filter(r=>r.level===this.index!.maxLevel).every(r=>this.tiles.has(previewKey(r.level,r.x,r.y)));}
    get pyramid(){return this.index;}
    setActive(active:boolean){this.visible=active;if(this.active===active)return;this.active=active;if(!active)this.spatial?.stop();if(!active)for(const controller of this.loads.values())controller.abort();}
    private intersects(a:Bounds,b:Bounds){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
    private tileInView(ref:PreviewTileRef,bounds:Bounds){
        const size=this.index!.tileSize*2**ref.level,x=ref.x*size,y=ref.y*size;
        if(!this.sourceSlots)return this.intersects({x,y,width:size,height:size},bounds);
        const key=previewKey(ref.level,ref.x,ref.y);let pieces=this.projectedBounds.get(key);
        if(!pieces){pieces=[];for(const [id,r] of this.slots.entries()){
            const s=this.sourceSlots[id],l=Math.max(x,s.x),t=Math.max(y,s.y),rr=Math.min(x+size,s.x+s.width),b=Math.min(y+size,s.y+s.height);
            if(rr>l&&b>t)pieces.push({x:l+r.x-s.x,y:t+r.y-s.y,width:rr-l,height:b-t});
        }this.projectedBounds.set(key,pieces);}
        return pieces.some(piece=>this.intersects(piece,bounds));
    }
    private visibleRefs(level:number,bounds:Bounds){
        if(!this.index)return [];
        if(this.sourceSlots)return (this.levels.get(level)||[]).filter(ref=>this.tileInView(ref,bounds));
        const size=this.index.tileSize*2**level;
        const left=Math.floor(bounds.x/size),top=Math.floor(bounds.y/size),right=Math.floor((bounds.x+bounds.width)/size),bottom=Math.floor((bounds.y+bounds.height)/size);
        return (this.levels.get(level)||[]).filter(ref=>ref.x>=left&&ref.x<=right&&ref.y>=top&&ref.y<=bottom);
    }
    levelReady(level:number,bounds:Bounds){if(this.regional)return true;level=Math.max(level,this.minimumLevel);return !!this.index&&this.visibleRefs(level,bounds).every(ref=>this.tiles.has(previewKey(level,ref.x,ref.y)));}
    updateView(bounds:Bounds,detail:number,target:number,strength=1,geometry?:PreviewGeometryCoverage){
        if(this.regional){
            if(!this.active||this.disposed)return;
            const visibleStrength=detail<=(this.index?.maxLevel??0)+1?strength:0;
            if(this.spatial&&this.spatialBounds){const weights=this.spatial.updateView(bounds,this.spatialBounds,this.spatialBlend,this.spatialPixels,visibleStrength,geometry,this.spatialDownloads);this.regional.setWeights(weights);}
            this.regional.updateView(bounds,visibleStrength,geometry);
            if(this.edges)this.edges.visible=false;return;
        }
        if(!this.index||!this.active||this.disposed)return;
        if(geometry?.cellSize&&geometry.cellSize!==this.coverageCellSize){
            this.coverageCellSize=geometry.cellSize;for(const tile of this.tiles.values())this.rebuildTile(tile);
        }
        const max=this.index.maxLevel,layers=detailLayers(detail),direction=Math.sign(target-detail);
        // A rapid zoom-out must not require hundreds of finest tiles merely to
        // finish the exact/preview handoff. Use one coarser source for the entire
        // view, never a different fallback level for each individual tile.
        this.minimumLevel=0;
        while(this.minimumLevel<max&&this.visibleRefs(this.minimumLevel,bounds).length>Math.min(32,Math.floor(this.tileCapacity/2)))this.minimumLevel++;
        const sourceLevel=(level:number)=>Math.max(level,this.minimumLevel);
        this.wanted.clear();this.priorities.clear();
        const want=(level:number,priority:number)=>{
            if(level<0||level>max)return;
            level=sourceLevel(level);
            for(const ref of this.visibleRefs(level,bounds)){
                const key=previewKey(level,ref.x,ref.y);this.wanted.add(key);this.priorities.set(key,Math.min(priority,this.priorities.get(key)??Infinity));
            }
        };
        // Current pair first, then the next boundary. A fast zoom cannot make
        // intermediate ancestors visible through several independently fading tiles.
        for(const layer of layers)want(max-layer.index,0);
        if(geometry)want(0,0);
        const next=direction>0?Math.floor(detail+1e-6)+1:Math.ceil(detail-1e-6)-1;
        if(direction!==0)want(max-next,1);
        for(const layer of detailLayers(Math.min(max,target)))want(max-layer.index,2);
        for(const ref of this.index.tiles)if(ref.level===max){const key=previewKey(max,ref.x,ref.y);this.wanted.add(key);this.priorities.set(key,3);}
        for(const [key,controller] of this.loads)if(!this.wanted.has(key))controller.abort();
        this.stats.level=Math.max(0,Math.min(max,Math.max(this.minimumLevel,Math.round(max-detail))));
        const now=performance.now();
        for(const tile of this.tiles.values()){
            let opacity=layers.reduce((sum,layer)=>sum+(layer.index<=max&&sourceLevel(max-layer.index)===tile.ref.level?layer.weight:0),0);
            let geometryOpacity=0,visibleOpacity=opacity;
            if(geometry&&tile.ref.level===sourceLevel(0)){
                opacity=1;geometryOpacity=geometry.opacity;visibleOpacity=0;
                const attribute=tile.mesh.geometry.getAttribute('geometryCoverage') as THREE.BufferAttribute;
                const inView=this.tileInView(tile.ref,bounds);
                const refresh=geometry.revision===undefined||tile.coverageRevision!==geometry.revision;
                let changed=false;
                if(inView)for(const patch of tile.patches){
                    const coverage=refresh?geometry.coverage(patch.bounds):patch.coverage;
                    if(coverage!==patch.coverage){
                        changed=true;patch.coverage=coverage;
                        (attribute.array as Float32Array).fill(coverage,patch.first,patch.first+patch.count);queueAttributeUpdateRange(attribute,patch.first,patch.count);
                    }
                    const p=patch.bounds;
                    if(p.x<bounds.x+bounds.width&&p.x+p.width>bounds.x&&p.y<bounds.y+bounds.height&&p.y+p.height>bounds.y)
                        visibleOpacity=Math.max(visibleOpacity,1-geometryOpacity*coverage);
                }
                if(inView)tile.coverageRevision=geometry.revision;
                if(changed)attribute.needsUpdate=true;
            }
            tile.mesh.visible=visibleOpacity>0;tile.mesh.material.uniforms.opacity.value=opacity*strength;
            tile.mesh.material.uniforms.geometryOpacity.value=geometryOpacity;
            if(visibleOpacity)tile.used=now;
        }
        if(this.edges){const opacity=Math.max(0,Math.min(1,max+1-detail));this.edges.visible=opacity>0;this.edges.material.opacity=opacity*.5;}
        this.pump();this.evict();
    }
    private pump(){
        if(this.regional||!this.index||!this.active||this.disposed)return;
        const queue=[...this.wanted].filter(key=>!this.tiles.has(key)&&!this.loads.has(key)&&(this.failures.get(key)||0)<Date.now()).sort((a,b)=>(this.priorities.get(a)??4)-(this.priorities.get(b)??4));
        for(const key of queue){
            if(this.loads.size>=4)break;
            const revision=this.revision,ref=this.refs.get(key)!,controller=new AbortController();this.loads.set(key,controller);this.stats.requests++;
            void this.source.getPreviewTile!(ref,this.index,controller.signal).then(pixels=>{
                if(this.disposed||controller.signal.aborted||revision!==this.revision)return;
                this.evict(true);if(this.tiles.size>=this.tileCapacity){this.failures.set(key,Date.now()+1000);return;}
                const data=pixels.buffer instanceof ArrayBuffer?new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength):new Uint8Array(pixels);
                const texture=new THREE.DataTexture(data,this.index!.resolution*(this.index!.channels??1),this.index!.resolution,THREE.RGBAFormat);
                texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
                const material=new THREE.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,uniforms:{...colorUniforms(),previewResolution:{value:this.index!.resolution},pixels:{value:texture},opacity:{value:0},geometryOpacity:{value:0}},
                    vertexShader:'attribute float geometryCoverage;varying vec2 texcoord;varying float exactCoverage;void main(){texcoord=uv;exactCoverage=geometryCoverage;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                    fragmentShader:`${sizeColorGLSL}
uniform float previewResolution;uniform vec3 baseColor;uniform float sizeColorMode;uniform sampler2D pixels;uniform float opacity;uniform float geometryOpacity;varying vec2 texcoord;varying float exactCoverage;
                    // Interpolate covered values in shader precision. Rounding the product
                    // back to a byte changes constant metrics as coverage varies.
                    vec2 coveredSample(vec2 uv){vec2 p=texture2D(pixels,uv).rg;return vec2(p.r*p.g,p.g);}
                    vec2 coveredPreview(vec2 uv){
                        vec2 grid=uv*previewResolution-.5,cell=floor(grid),f=fract(grid);
                        vec2 a=(cell+.5)/previewResolution,b=(cell+1.5)/previewResolution;
                        return mix(mix(coveredSample(a),coveredSample(vec2(b.x,a.y)),f.x),
                                   mix(coveredSample(vec2(a.x,b.y)),coveredSample(b),f.x),f.y);
                    }
                    void main(){
                    if(parcelClassMode>.5){
                        float u=clamp(texcoord.x,.5/previewResolution,1.-.5/previewResolution);
                        vec4 a=texture2D(pixels,vec2(u/3.,texcoord.y)),b=texture2D(pixels,vec2((u+1.)/3.,texcoord.y)),c=texture2D(pixels,vec2((u+2.)/3.,texcoord.y));
                        float weights[9];weights[0]=a.r;weights[1]=a.g;weights[2]=a.b;weights[3]=a.a;weights[4]=b.r;weights[5]=b.g;weights[6]=b.b;weights[7]=b.a;weights[8]=c.r;
                        float totalWeight=0.,chosen=0.,score=0.;for(int i=0;i<9;i++){float side=float(i+1),w=parcelClassWeight(side,weights[i]);totalWeight+=weights[i];chosen+=w;score+=w*side;}
                        vec3 color=parcelCoverageColor(parcelSizeColor(chosen>.00001?score/chosen:1.),totalWeight>.00001?chosen/totalWeight:0.);
                        gl_FragColor=vec4(color,c.g*opacity*(1.-geometryOpacity*exactCoverage));
                    }else{vec2 p=coveredPreview(texcoord);
                    float heat=p.g>.0001?clamp(p.r/p.g,0.,1.):0.;float v=.2+.8*heat;vec3 color=metricEnabled>.5?filterColor(parcelSizeColor(heat*15.),heat*15.):(sizeColorMode>1.5?filterColor(bitmapAreaColor(heat*145908.),bitmapAreaScore(heat*145908.)):(sizeColorMode>.5?parcelSizeColor(heat*15.):(heatmapEnabled>.5?parcelSizeColor(1.+heat*8.):baseColor)));gl_FragColor=vec4(color,p.g*opacity*(1.-geometryOpacity*exactCoverage));}
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    }`});
                material.uniforms.parcelClassMode.value=this.parcelClassMode?1:0;material.uniforms.parcelMin.value=this.parcelRange[0];material.uniforms.parcelMax.value=this.parcelRange[1];material.uniforms.metricEnabled.value=this.analyticMode?1:0;material.uniforms.filterMin.value=this.filterRange[0];material.uniforms.filterMax.value=this.filterRange[1];material.uniforms.heatmapEnabled.value=this.heatmapMode?1:0;material.uniforms.sizeColorMode.value=this.areaColorMode?2:(this.sizeColorMode?1:0);material.uniforms.bitmapAreaLog.value=this.areaLog?1:0;material.uniforms.bitmapAreaMax.value=this.areaMax;material.uniforms.bitmapAreaMin.value=this.areaMin;setColors(material.uniforms,this.colors);
                const {geometry,patches}=this.tileGeometry(ref),mesh=new THREE.Mesh(geometry,material),size=this.index!.tileSize*2**ref.level;
                geometry.computeBoundingSphere();
                mesh.scale.set(size,1,size);mesh.position.set(ref.x*size,.01,ref.y*size);mesh.renderOrder=.5+(this.index!.maxLevel-ref.level)*.01;mesh.raycast=()=>{};
                this.add(mesh);this.tiles.set(key,{ref,mesh,texture,patches,used:performance.now()});this.stats.loaded++;this.changed();
            }).catch(error=>{if(!controller.signal.aborted&&!this.disposed){this.failures.set(key,Date.now()+10000);this.report(error);}}).finally(()=>{if(this.loads.get(key)===controller)this.loads.delete(key);this.pump();});
        }
    }
    private evict(required=false){
        for(const [key,tile] of [...this.tiles].sort((a,b)=>a[1].used-b[1].used)){
            if(this.tiles.size<(required?this.tileCapacity:this.tileCapacity+1))break;if(this.wanted.has(key)||!required&&tile.mesh.visible)continue;
            tile.texture.dispose();tile.mesh.geometry.dispose();tile.mesh.material.dispose();tile.mesh.removeFromParent();this.tiles.delete(key);
        }
        this.stats.tiles=this.tiles.size;this.stats.textureBytes=this.tiles.size*(this.index?.resolution||0)**2*4*(this.index?.channels??1);
    }
    dispose(){if(this.disposed)return;this.disposed=true;this.regional?.dispose();this.spatial?.dispose();for(const controller of this.loads.values())controller.abort();this.loads.clear();for(const tile of this.tiles.values()){tile.texture.dispose();tile.mesh.geometry.dispose();tile.mesh.material.dispose();}this.tiles.clear();this.edges?.geometry.dispose();this.edges?.material.dispose();this.clear();this.removeFromParent();}
}
