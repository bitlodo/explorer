import * as THREE from 'three';
import type {NeighborhoodData} from '@/map/types';
import type {NeighborhoodSlot} from '@shared/NeighborhoodLayout';
import {CreateBufferPlaneGeometry} from '@/map/layers/planeGeometry';
import type {NeighborhoodChunk} from '@shared/neighborhoodChunks';
import type BitmapArrivalFades from './BitmapArrivalFades';
import {colorUniforms,sizeColorGLSL,setColors,setMetricUniforms,setParcelUniforms} from './ParcelSizeColors';
import {ArrivalFade,GEOMETRY_PREVIEW_EXIT_SECONDS} from '@shared/ArrivalFade';
import {bitmapArrivalGLSL} from '@shared/bitmapArrival';
import {rectangleCoverageVertexGLSL,rectangleCoverageFragmentGLSL} from './RectangleCoverage';

type Bounds={x:number;y:number;width:number;height:number};
type Entry={mesh:THREE.Mesh<THREE.InstancedBufferGeometry,THREE.ShaderMaterial>;used:number;bytes:number;arrival:ArrivalFade;previewExit:ArrivalFade;regionCounts?:Map<number,number>};
type CoverageProof={opacity:number;chunks:Set<string>;regions:Set<number>};
/** Canonical bitmap bases, 24 bytes/bitmap including stable ID for parcel fades. */
export default class NeighborhoodGeometryLayer extends THREE.Group {
    readonly formatVersion='neighborhood-vectors-v2-rect4f-heat1f-id32';
    readonly capacity=256;
    readonly regions=new Map<number,Entry>();
    readonly chunks=new Map<string,Entry>();
    readonly chunkCapacity=2048;
    private wantedChunks=new Set<string>();
    private wantedOwners:{key:string;x:number;y:number}[]=[];
    private wantedChunkBounds=new Map<string,Bounds>();
    private wanted=new Set<number>();
    private slots:readonly NeighborhoodSlot[]=[];
    private chunkSize=0;
    private coverageBounds?:Bounds;
    private coverageRevision=0;
    private knownEmptyCells=new Set<string>();
    private completeRegionOwners=new Map<number,{count:number;owners:Set<string>}>();
    private previewProofs=new Map<string,CoverageProof>();
    private maxRegionWidth=0;
    private maxRegionHeight=0;
    // Bitmap scores and arrival gains are constant per instance, including at exact filter endpoints.
    private material=new THREE.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,uniforms:{inspectedBitmap:{value:-1},bitmapMargin:{value:.5},rectangleSmoothing:{value:1},rectanglePixelsPerWorld:{value:1},...colorUniforms(),meanSizes:{value:null},meanTextureSize:{value:new THREE.Vector2(1,1)},geometryArrival:{value:0},opacity:{value:0},parcelOpacity:{value:0},arrivalMap:{value:null},arrivalMapSize:{value:new THREE.Vector2(1,1)},arrivalEnabled:{value:0}},
        vertexShader:`${rectangleCoverageVertexGLSL}
${bitmapArrivalGLSL}
uniform float bitmapMargin;uniform float inspectedBitmap;flat varying float vInspected;flat varying float vBitmapMargin;
attribute vec4 bitmapRect;attribute float heat;attribute uint bitmapId;flat varying float vHeat;flat varying float vBaseOpacity;flat varying float vParcelCoverage;flat varying float vBitmapPixels;
        uniform sampler2D arrivalMap;uniform vec2 arrivalMapSize;uniform float arrivalEnabled;uniform float parcelOpacity;
        uniform float parcelClassMode;uniform sampler2D parcelValues;uniform vec2 parcelTextureSize;uniform sampler2D meanSizes;uniform vec2 meanTextureSize;uniform float sizeColorMode;uniform float metricEnabled;uniform sampler2D metricValues;uniform vec2 metricTextureSize;
        void main(){vInspected=abs(float(bitmapId)-inspectedBitmap)<.5?1.:0.;vHeat=heat;if(sizeColorMode>.5&&sizeColorMode<1.5)vHeat=texture2D(meanSizes,(vec2(float(bitmapId%uint(meanTextureSize.x)),float(bitmapId/uint(meanTextureSize.x)))+.5)/meanTextureSize).r;if(metricEnabled>.5)vHeat=texture2D(metricValues,(vec2(mod(float(bitmapId),metricTextureSize.x),floor(float(bitmapId)/metricTextureSize.x))+.5)/metricTextureSize).r;vParcelCoverage=1.;if(parcelClassMode>.5){vec2 summary=texture2D(parcelValues,(vec2(mod(float(bitmapId),parcelTextureSize.x),floor(float(bitmapId)/parcelTextureSize.x))+.5)/parcelTextureSize).rg;vHeat=summary.r;vParcelCoverage=summary.g;}vBaseOpacity=1.;uint rowWidth=uint(arrivalMapSize.x);if(arrivalEnabled>.5)vBaseOpacity-=parcelOpacity*bitmapBaseExit(texture2D(arrivalMap,(vec2(float(bitmapId%rowWidth),float(bitmapId/rowWidth))+.5)/arrivalMapSize).r);
        vBitmapMargin=min(bitmapMargin,.5*min(bitmapRect.z+.5,bitmapRect.w+.5));vBitmapPixels=min(bitmapRect.z+.5,bitmapRect.w+.5)*rectanglePixelsPerWorld;vec2 offset=rectanglePosition(position.xz,bitmapRect.zw+vec2(.5-vBitmapMargin),vBitmapMargin);vec3 p=vec3(bitmapRect.x+offset.x,0.,bitmapRect.y+offset.y);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
        fragmentShader:`${rectangleCoverageFragmentGLSL}
${sizeColorGLSL}
flat varying float vInspected;flat varying float vBitmapMargin;flat varying float vBitmapPixels;uniform vec3 baseColor;uniform float sizeColorMode;uniform float opacity;uniform float geometryArrival;flat varying float vHeat;flat varying float vBaseOpacity;flat varying float vParcelCoverage;void main(){float v=.2+.8*vHeat;vec3 color=parcelClassMode>.5?parcelCoverageColor(parcelSizeColor(vHeat),vParcelCoverage):(metricEnabled>.5?filterColor(parcelSizeColor(vHeat),vHeat):(sizeColorMode>1.5?filterColor(bitmapAreaColor(1.+vHeat*145907.),bitmapAreaScore(1.+vHeat*145907.)):(sizeColorMode>.5?parcelSizeColor(vHeat):(heatmapEnabled>.5?parcelSizeColor(1.+vHeat*8.):baseColor))));float coverage=rectangleDetailCoverage(vBitmapMargin,vBitmapPixels);gl_FragColor=vec4(vInspected>.5?vec3(1.):color,opacity*geometryArrival*vBaseOpacity*coverage);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`});
    private labels?:THREE.Mesh<THREE.InstancedBufferGeometry,THREE.ShaderMaterial>;
    private labelTexture?:THREE.CanvasTexture;
    readonly stats={loaded:0,visible:0,bytes:0};
    constructor(slots:readonly NeighborhoodSlot[]){super();this.name='neighborhood-vector-geometry';this.setLayout(slots);}
    setParcelClasses(texture?:THREE.DataTexture,low=1,high=9){setParcelUniforms(this.material.uniforms,texture,low,high);}
    setAnalytic(texture?:THREE.DataTexture,low=1,high=9){setMetricUniforms(this.material.uniforms,texture,low,high);}
    setInspectedBitmap(id=-1){this.material.uniforms.inspectedBitmap.value=id;}
    setHeatmap(enabled:boolean){this.material.uniforms.heatmapEnabled.value=enabled?1:0;}
    setBitmapAreaMode(enabled:boolean,maxArea=145908,minArea=1,logarithmic=false){this.material.uniforms.bitmapAreaLog.value=logarithmic?1:0;this.material.uniforms.bitmapAreaMax.value=maxArea;this.material.uniforms.bitmapAreaMin.value=minArea;if(enabled)this.material.uniforms.sizeColorMode.value=2;}
    setSizeColorMode(enabled:boolean,texture?:THREE.DataTexture){this.material.uniforms.sizeColorMode.value=enabled?1:0;if(texture){this.material.uniforms.meanSizes.value=texture;this.material.uniforms.meanTextureSize.value.set(texture.image.width,texture.image.height);}}
    setSizeColors(colors:readonly string[]){setColors(this.material.uniforms,colors);}
    setArrivalFades(fades:BitmapArrivalFades){fades.bind(this.material.uniforms);}
    setLayout(slots:readonly NeighborhoodSlot[]){
        this.slots=slots;this.knownEmptyCells.clear();this.previewProofs.clear();this.coverageRevision++;
        this.maxRegionWidth=Math.max(0,...slots.map(s=>s.width));this.maxRegionHeight=Math.max(0,...slots.map(s=>s.height));
        if(this.labels){this.labels.geometry.dispose();this.labels.material.dispose();this.labels.removeFromParent();this.labelTexture?.dispose();}
        const cols=16,cw=40,ch=28,canvas=document.createElement('canvas');canvas.width=cols*cw;canvas.height=Math.ceil(slots.length/cols)*ch;
        const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.font='18px sans-serif';ctx.textBaseline='top';
        const anchors=new Float32Array(slots.length*4),uvs=new Float32Array(slots.length*4),sizes=new Float32Array(slots.length);
        slots.forEach((r,id)=>{const text=String(id),x=(id%cols)*cw,y=Math.floor(id/cols)*ch,w=Math.ceil(ctx.measureText(text).width)+4;
            ctx.fillText(text,x+2,y+2);anchors.set([r.x,r.y,w,ch],id*4);uvs.set([x/canvas.width,y/canvas.height,w/canvas.width,ch/canvas.height],id*4);sizes[id]=Math.min(r.width,r.height);
        });
        this.labelTexture=new THREE.CanvasTexture(canvas);this.labelTexture.minFilter=this.labelTexture.magFilter=THREE.LinearFilter;this.labelTexture.generateMipmaps=false;this.labelTexture.flipY=false;
        const plane=CreateBufferPlaneGeometry(),g=new THREE.InstancedBufferGeometry();g.setIndex(plane.index);g.setAttribute('position',plane.getAttribute('position'));g.setAttribute('uv',plane.getAttribute('uv'));
        g.setAttribute('anchor',new THREE.InstancedBufferAttribute(anchors,4));g.setAttribute('atlasRect',new THREE.InstancedBufferAttribute(uvs,4));g.setAttribute('regionSize',new THREE.InstancedBufferAttribute(sizes,1));g.instanceCount=slots.length;
        const m=new THREE.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,uniforms:{atlas:{value:this.labelTexture},worldPerPixel:{value:1},opacity:{value:0}},
            vertexShader:`attribute vec4 anchor;attribute vec4 atlasRect;attribute float regionSize;uniform float worldPerPixel;varying vec2 texcoord;varying float visibleLabel;
            void main(){texcoord=atlasRect.xy+uv*atlasRect.zw;visibleLabel=step(70.,regionSize/worldPerPixel);vec3 p=vec3(anchor.x+(8.+position.x*anchor.z)*worldPerPixel,.04,anchor.y+(8.+position.z*anchor.w)*worldPerPixel);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
            fragmentShader:`uniform sampler2D atlas;uniform float opacity;varying vec2 texcoord;varying float visibleLabel;void main(){vec4 p=texture2D(atlas,texcoord);gl_FragColor=vec4(1.,1.,1.,p.a*opacity*visibleLabel);}`});
        this.labels=new THREE.Mesh(g,m);this.labels.frustumCulled=false;this.labels.renderOrder=4;this.labels.raycast=()=>{};this.add(this.labels);
    }
    get previewCellSize(){return this.chunkSize;}
    get previewCoverageRevision(){return this.coverageRevision;}
    has(id:number){return this.regions.has(id);}
    setWanted(ids:Iterable<number>){const next=new Set(ids);if(next.size!==this.wanted.size||[...next].some(id=>!this.wanted.has(id)))this.coverageRevision++;this.wanted=next;}
    setWantedChunks(keys:Iterable<string>,bounds?:Bounds,extents?:ReadonlyMap<string,Bounds>){this.wantedChunks=new Set(keys);this.wantedOwners=[...this.wantedChunks].map(key=>{const [x,y]=key.split(',').map(Number);return{key,x,y};});this.wantedChunkBounds=new Map(extents);this.coverageBounds=bounds;this.rememberEmptyCells();this.coverageRevision++;}
    private rememberEmptyCells(){
        const b=this.coverageBounds;if(!b||!this.chunkSize)return;
        const left=Math.floor(b.x/this.chunkSize),top=Math.floor(b.y/this.chunkSize),right=Math.ceil((b.x+b.width)/this.chunkSize)-1,bottom=Math.ceil((b.y+b.height)/this.chunkSize)-1;
        if((right-left+1)*(bottom-top+1)>this.chunkCapacity)return;
        // A completed index query also proves which intersecting owner cells
        // have no file. Keep that fact bounded, so empty map gaps don't flicker
        // when zoom-out temporarily outruns the latest query rectangle.
        for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
            const key=`${x},${y}`;this.knownEmptyCells.delete(key);
            if(!this.wantedChunks.has(key)){this.knownEmptyCells.add(key);if(this.knownEmptyCells.size>this.chunkCapacity)this.knownEmptyCells.delete(this.knownEmptyCells.values().next().value!);}
        }
    }
    hasChunk(key:string){return this.chunks.has(key);}
    addChunk(chunk:NeighborhoodChunk){
        const key=`${chunk.x},${chunk.y}`;if(this.chunks.has(key))return true;
        if(this.chunkSize!==chunk.size){this.chunkSize=chunk.size;this.rememberEmptyCells();}
        const bytes=chunk.bitmaps.length*24;
        while(this.chunks.size>=this.chunkCapacity||this.stats.bytes+bytes>32*1024*1024){
            const victim=[...this.chunks].filter(([id])=>!this.wantedChunks.has(id)&&!this.chunks.get(id)!.mesh.visible).sort((a,b)=>a[1].used-b[1].used)[0];
            if(!victim)return false;this.removeChunk(victim[0]);this.refreshStats();
        }
        const x=chunk.x*chunk.size,y=chunk.y*chunk.size,rects=new Float32Array(chunk.bitmaps.length*4),heat=new Float32Array(chunk.bitmaps.length),ids=new Uint32Array(chunk.bitmaps.length);
        let width=chunk.size,height=chunk.size;
        chunk.bitmaps.forEach((r,i)=>{ids[i]=r.id;rects.set([r.x-x,r.y-y,Math.max(0,r.width-.5),Math.max(0,r.height-.5)],i*4);heat[i]=Math.max(0,Math.min(1,(r.width*r.height-1)/145907));width=Math.max(width,r.x-x+r.width);height=Math.max(height,r.y-y+r.height);});
        const mesh=this.bitmapMesh(rects,heat,ids,{x,y,width,height});
        const entry=this.arrivingEntry(mesh,bytes),counts=new Map<number,number>();
        // Authenticated top-left ownership gives disjoint IDs across chunks.
        // A full set certifies the neighborhood, including natural empty cells.
        for(const bitmap of chunk.bitmaps){const region=Math.floor(bitmap.id/2016);counts.set(region,(counts.get(region)||0)+1);}
        entry.regionCounts=counts;this.chunks.set(key,entry);
        for(const [region,count] of counts){let coverage=this.completeRegionOwners.get(region);if(!coverage){coverage={count:0,owners:new Set()};this.completeRegionOwners.set(region,coverage);}coverage.count+=count;coverage.owners.add(key);}
        this.coverageRevision++;this.refreshStats();return true;
    }
    addRegion(data:NeighborhoodData,slot:NeighborhoodSlot){
        if(this.regions.has(data.neighborhood))return true;
        if(this.regions.size>=this.capacity){const victim=[...this.regions].filter(([id])=>!this.wanted.has(id)&&!this.regions.get(id)!.mesh.visible).sort((a,b)=>a[1].used-b[1].used)[0];if(!victim)return false;this.removeRegion(victim[0]);}
        const rects=new Float32Array(data.bitmaps.length*4),heat=new Float32Array(data.bitmaps.length),ids=new Uint32Array(data.bitmaps.length);
        data.bitmaps.forEach((r,i)=>{ids[i]=data.neighborhood*2016+i;rects.set([r.x,r.y,Math.max(0,r.width-.5),Math.max(0,r.height-.5)],i*4);heat[i]=Math.max(0,Math.min(1,(r.width*r.height-1)/145907));});
        const mesh=this.bitmapMesh(rects,heat,ids,{x:slot.x,y:slot.y,width:data.width,height:data.height});
        this.regions.set(data.neighborhood,this.arrivingEntry(mesh,rects.byteLength+heat.byteLength+ids.byteLength));this.coverageRevision++;this.refreshStats();return true;
    }
    private bitmapMesh(rects:Float32Array,heat:Float32Array,ids:Uint32Array,bounds:Bounds):Entry['mesh'] {
        const plane=CreateBufferPlaneGeometry(),g=new THREE.InstancedBufferGeometry();
        g.setIndex(plane.index);g.setAttribute('position',plane.getAttribute('position'));
        g.setAttribute('bitmapRect',new THREE.InstancedBufferAttribute(rects,4));
        g.setAttribute('heat',new THREE.InstancedBufferAttribute(heat,1));
        g.setAttribute('bitmapId',new THREE.InstancedBufferAttribute(ids,1));g.instanceCount=ids.length;
        g.boundingBox=new THREE.Box3(new THREE.Vector3(0,-.1,0),new THREE.Vector3(bounds.width,.1,bounds.height));
        g.boundingSphere=new THREE.Sphere();g.boundingBox.getBoundingSphere(g.boundingSphere);
        const mesh=new THREE.Mesh(g,this.material);mesh.position.set(bounds.x,.02,bounds.y);
        mesh.renderOrder=2;mesh.raycast=()=>{};mesh.visible=false;this.add(mesh);return mesh;
    }
    private arrivingEntry(mesh:Entry['mesh'],bytes:number):Entry {
        const entry={mesh,bytes,used:performance.now(),arrival:new ArrivalFade(),previewExit:new ArrivalFade(GEOMETRY_PREVIEW_EXIT_SECONDS)};
        mesh.onBeforeRender=()=>{
            // In the parcel band the exact base must already cover every new
            // bitmap until its own arrival atlas hands coverage to parcels.
            this.material.uniforms.geometryArrival.value=this.material.uniforms.parcelOpacity.value>0?1:entry.arrival.opacity;
            this.material.uniformsNeedUpdate=true;
        };
        return entry;
    }
    /** Conservative coverage for one fixed world-space preview piece. Unknown
     * owners retain the preview, including bitmaps extending past their cell.
     */
    previewCoverage(bounds:Bounds,region?:number){
        // A complete, settled region proves every child patch without scanning
        // incoming-owner bounds or displacing unrelated cached coverage proofs.
        if(region!==undefined){
            if(this.regions.get(region)?.previewExit.opacity===1)return 1;
            const complete=this.completeRegionOwners.get(region);
            if(complete?.count===2016&&[...complete.owners].every(owner=>this.chunks.get(owner)?.previewExit.opacity===1))return 1;
        }
        const key=`${region??''}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        const previous=this.previewProofs.get(key);
        if(previous){
            this.previewProofs.delete(key);this.previewProofs.set(key,previous);
            if(previous.opacity<1){
                let opacity=1;
                for(const owner of previous.chunks)opacity=Math.min(opacity,this.chunks.get(owner)?.previewExit.opacity??0);
                for(const id of previous.regions)opacity=Math.min(opacity,this.regions.get(id)?.previewExit.opacity??0);
                previous.opacity=Math.max(previous.opacity,opacity);
            }
            if(previous.opacity===1)return 1;
        }
        const proof:CoverageProof={opacity:0,chunks:new Set(),regions:new Set()};
        proof.opacity=this.cellPreviewCoverage(bounds,proof);
        if(region!==undefined){
            const full=this.regions.get(region);
            const complete=this.completeRegionOwners.get(region);
            if(full&&full.previewExit.opacity>proof.opacity){proof.opacity=full.previewExit.opacity;proof.chunks.clear();proof.regions=new Set([region]);}
            else if(complete?.count===2016){
                let opacity=1;for(const owner of complete.owners)opacity=Math.min(opacity,this.chunks.get(owner)?.previewExit.opacity??0);
                if(opacity>proof.opacity){proof.opacity=opacity;proof.chunks=new Set(complete.owners);proof.regions.clear();}
            }
        }
        // A request set describes new work, not resident coverage. Once a fixed
        // patch has handed off, later conservative incoming-owner bounds cannot
        // bring its summary back. Only eviction of its actual proof can do so.
        if(previous&&previous.opacity>=proof.opacity)return previous.opacity;
        if(proof.opacity>0){
            this.previewProofs.set(key,proof);
            if(this.previewProofs.size>this.chunkCapacity)this.previewProofs.delete(this.previewProofs.keys().next().value!);
        }
        return proof.opacity;
    }
    private cellPreviewCoverage(bounds:Bounds,proof:CoverageProof){
        const intersects=(x:number,y:number,width:number,height:number)=>x<bounds.x+bounds.width&&x+width>bounds.x&&y<bounds.y+bounds.height&&y+height>bounds.y;
        let alpha=1,seen=false;
        if(this.chunkSize){
            const known=this.coverageBounds;
            const queryCovers=known&&bounds.x>=known.x&&bounds.y>=known.y&&bounds.x+bounds.width<=known.x+known.width&&bounds.y+bounds.height<=known.y+known.height;
            if(!queryCovers){
                // Zoom-out expands the viewport before its metadata query catches
                // up. Complete resident owner cells still provide coverage: a
                // stale query rectangle must not bring the whole preview back.
                const left=Math.floor(bounds.x/this.chunkSize),top=Math.floor(bounds.y/this.chunkSize);
                const right=Math.ceil((bounds.x+bounds.width)/this.chunkSize)-1,bottom=Math.ceil((bounds.y+bounds.height)/this.chunkSize)-1;
                if((right-left+1)*(bottom-top+1)>this.chunkCapacity)return 0;
                for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
                    const key=`${x},${y}`,entry=this.chunks.get(key);
                    if(!entry){if(this.knownEmptyCells.has(key))continue;return 0;}
                    proof.chunks.add(key);seen=true;alpha=Math.min(alpha,entry.previewExit.opacity);
                }
            }
            for(const {key,x,y} of this.wantedOwners){
                const entry=this.chunks.get(key),b=entry?.mesh.geometry.boundingBox;
                const pending=!entry?this.wantedChunkBounds.get(key):undefined;
                if(!intersects(pending?.x??x*this.chunkSize,pending?.y??y*this.chunkSize,pending?.width??b?.max.x??this.chunkSize+this.maxRegionWidth,pending?.height??b?.max.z??this.chunkSize+this.maxRegionHeight))continue;
                if(entry)proof.chunks.add(key);
                seen=true;alpha=Math.min(alpha,entry?.previewExit.opacity??0);
            }
        }else for(const [id,slot] of this.slots.entries()){if(!slot||!intersects(slot.x,slot.y,slot.width,slot.height))continue;if(this.regions.has(id))proof.regions.add(id);seen=true;alpha=Math.min(alpha,this.regions.get(id)?.previewExit.opacity??0);}
        return seen?alpha:(this.chunkSize&&this.coverageBounds||this.wanted.size>0)?1:0;
    }
    updateView(bounds:Bounds,opacity:number,worldPerPixel:number,parcelOpacity=0,now=performance.now()){
        this.material.uniforms.rectanglePixelsPerWorld.value=1/worldPerPixel;
        // Keep unloaded bitmap bases distinct in the parcel band too. Completed
        // parcel detail replaces the base without changing its own geometry.
        // Small cells retain at least half of each axis in the vertex shader.
        this.material.uniforms.bitmapMargin.value=Math.max(.5,worldPerPixel);
        this.visible=opacity>0;this.material.uniforms.opacity.value=opacity;this.material.uniforms.parcelOpacity.value=parcelOpacity;let visible=0,coverageChanged=false;
        for(const entry of this.regions.values()){const previous=entry.previewExit.opacity;entry.arrival.update(now);if(entry.arrival.opacity===1)entry.previewExit.update(now);coverageChanged ||= previous!==entry.previewExit.opacity;const b=entry.mesh.geometry.boundingBox!;entry.mesh.visible=entry.mesh.position.x<bounds.x+bounds.width&&entry.mesh.position.x+b.max.x>bounds.x&&entry.mesh.position.z<bounds.y+bounds.height&&entry.mesh.position.z+b.max.z>bounds.y;if(entry.mesh.visible){visible++;entry.used=performance.now();}}
        for(const entry of this.chunks.values()){const previous=entry.previewExit.opacity;entry.arrival.update(now);if(entry.arrival.opacity===1)entry.previewExit.update(now);coverageChanged ||= previous!==entry.previewExit.opacity;const b=entry.mesh.geometry.boundingBox!;entry.mesh.visible=entry.mesh.position.x<bounds.x+bounds.width&&entry.mesh.position.x+b.max.x>bounds.x&&entry.mesh.position.z<bounds.y+bounds.height&&entry.mesh.position.z+b.max.z>bounds.y;if(entry.mesh.visible){visible++;entry.used=performance.now();}}
        if(coverageChanged)this.coverageRevision++;
        if(this.labels){this.labels.material.uniforms.opacity.value=opacity;this.labels.material.uniforms.worldPerPixel.value=worldPerPixel;}
        this.stats.visible=opacity>0?visible:0;
    }
    private refreshStats(){this.stats.loaded=this.regions.size+this.chunks.size;this.stats.bytes=[...this.regions.values(),...this.chunks.values()].reduce((sum,r)=>sum+r.bytes,0);}
    private removeChunk(key:string){
        const entry=this.chunks.get(key);if(!entry)return;
        for(const [patch,proof] of this.previewProofs)if(proof.chunks.has(key))this.previewProofs.delete(patch);
        for(const [region,count] of entry.regionCounts||[]){const coverage=this.completeRegionOwners.get(region);if(coverage){coverage.count-=count;coverage.owners.delete(key);if(!coverage.count)this.completeRegionOwners.delete(region);}}
        entry.mesh.geometry.dispose();entry.mesh.removeFromParent();this.chunks.delete(key);this.coverageRevision++;
    }
    private removeRegion(id:number){const entry=this.regions.get(id);if(!entry)return;for(const [patch,proof] of this.previewProofs)if(proof.regions.has(id))this.previewProofs.delete(patch);entry.mesh.geometry.dispose();entry.mesh.removeFromParent();this.regions.delete(id);this.coverageRevision++;this.refreshStats();}
    dispose(){for(const id of [...this.regions.keys()])this.removeRegion(id);for(const key of [...this.chunks.keys()])this.removeChunk(key);this.knownEmptyCells.clear();this.wantedChunkBounds.clear();this.previewProofs.clear();this.refreshStats();this.material.dispose();this.labels?.geometry.dispose();this.labels?.material.dispose();this.labelTexture?.dispose();this.clear();this.removeFromParent();}
}
