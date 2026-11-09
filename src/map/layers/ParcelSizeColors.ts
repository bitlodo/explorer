import * as THREE from 'three';
import { PARCEL_SIZE_COLORS, REGION_MIN_INTENSITY } from '@shared/layerPresentation';
export { PARCEL_SIZE_COLORS, BITMAP_AREA_COLORS } from '@shared/layerPresentation';
export type { RenderingMode } from '@shared/layerPresentation';
export const MAP_BASE_COLOR='#f5a340';
export const MAP_BACKGROUND='#17191d';
export const MAP_DISABLED_COLOR='#24272d';
export const sizeColorGLSL=`uniform vec3 disabledColor;uniform float minIntensity;
// Shares modulate intensity; zero membership is always excluded gray.
vec3 densityColor(vec3 color,float share){
 if(share<0.)return disabledColor;
 float gain=mix(minIntensity,1.,sqrt(clamp(share,0.,1.)));
 float c2=dot(color,color),cd=dot(color,disabledColor);
 float discriminant=cd*cd-c2*(dot(disabledColor,disabledColor)-.035*.035);
 float contrastGain=c2>.000001?(cd+sqrt(max(0.,discriminant)))/c2:1.;
 gain=max(gain,clamp(contrastGain,minIntensity,1.));
 return share>0.?color*gain:disabledColor;
}
uniform float parcelClassMode;uniform sampler2D parcelValues;uniform vec2 parcelTextureSize;uniform float parcelMin;uniform float parcelMax;
vec3 parcelCoverageColor(vec3 color,float coverage){return densityColor(color,coverage);}
float parcelClassWeight(float side,float weight){return weight*step(parcelMin-.01,side)*step(side,parcelMax+.01);}
uniform float metricEnabled;
uniform sampler2D metricValues;uniform vec2 metricTextureSize;
uniform float filterMin;uniform float filterMax;uniform float heatmapEnabled;
float bitmapMetric(float id){return texture2D(metricValues,(vec2(mod(id,metricTextureSize.x),floor(id/metricTextureSize.x))+.5)/metricTextureSize).r;}
vec3 filterColor(vec3 color,float value){if(value<0.)return disabledColor;float match=step(filterMin-.000001,value)*step(value,filterMax+.000001);return mix(disabledColor,color,match);}
uniform vec3 sizeColors[9];
vec3 parcelSizeColor(float value){
 float t=clamp(value-1.,0.,8.);vec3 result=sizeColors[0];
 for(int i=0;i<8;i++){result=mix(result,sizeColors[i+1],clamp(t-float(i),0.,1.));}
 return result;
}
uniform float bitmapAreaMax;uniform float bitmapAreaMin;uniform float bitmapAreaLog;
float bitmapAreaScore(float area){float value=area,low=bitmapAreaMin,high=bitmapAreaMax;if(bitmapAreaLog>.5){value=log(1.+value);low=log(1.+low);high=log(1.+high);}float span=high-low;return 1.+(span>0.?clamp((value-low)/span,0.,1.):0.)*8.;}
vec3 bitmapAreaColor(float area){return parcelSizeColor(bitmapAreaScore(area));}
`;
export const colorUniforms=()=>({minIntensity:{value:REGION_MIN_INTENSITY},disabledColor:{value:new THREE.Color(MAP_DISABLED_COLOR)},parcelClassMode:{value:0},parcelValues:{value:null},parcelTextureSize:{value:new THREE.Vector2(1,1)},parcelMin:{value:1},parcelMax:{value:9},metricEnabled:{value:0},metricValues:{value:null},metricTextureSize:{value:new THREE.Vector2(1,1)},filterMin:{value:1},filterMax:{value:9},heatmapEnabled:{value:0},baseColor:{value:new THREE.Color(MAP_BASE_COLOR)},bitmapAreaLog:{value:0},bitmapAreaMin:{value:1},bitmapAreaMax:{value:145908},sizeColorMode:{value:0},sizeColors:{value:paletteColors(PARCEL_SIZE_COLORS)}});
/** Expand three metric anchors to the existing nine-stop shader palette in linear RGB. */
export function paletteColors(colors: readonly string[]): THREE.Color[] {
 const anchors=colors.map(c=>new THREE.Color(c));
 if(colors.length===2)return Array.from({length:9},(_,i)=>anchors[0].clone().lerp(anchors[1],i/8));
 if(colors.length!==3)return anchors;
 return Array.from({length:9},(_,i)=>{const t=i/4,a=Math.min(1,Math.floor(t));return anchors[a].clone().lerp(anchors[a+1],t-a);});
}
export function setColors(uniforms:Record<string,THREE.IUniform>,colors:readonly string[]){
 if(![2,3,9].includes(colors.length)||colors.some(c=>!/^#[0-9a-f]{6}$/i.test(c)))throw Error('Choose two area colors, three metric colors or nine parcel colors');
 uniforms.sizeColors.value=paletteColors(colors);

}

export function setMetricUniforms(uniforms:Record<string,THREE.IUniform>,texture?:THREE.DataTexture,low=1,high=9){
 uniforms.metricEnabled.value=texture?1:0;uniforms.metricValues.value=texture??null;
 if(texture)uniforms.metricTextureSize.value.set(texture.image.width,texture.image.height);
 uniforms.filterMin.value=low;uniforms.filterMax.value=high;
}

export function setParcelUniforms(uniforms:Record<string,THREE.IUniform>,texture?:THREE.DataTexture,low=1,high=9){
 uniforms.parcelClassMode.value=texture?1:0;uniforms.parcelValues.value=texture??null;
 if(texture)uniforms.parcelTextureSize.value.set(texture.image.width,texture.image.height);
 uniforms.parcelMin.value=low;uniforms.parcelMax.value=high;
}

/** CSS uses sampled sRGB stops from the same linear RGB interpolation as the GPU. */
export const paletteGradient = (colors: readonly string[]) => `linear-gradient(90deg, ${paletteColors(colors).map(c=>'#'+c.getHexString()).join(',')})`;
