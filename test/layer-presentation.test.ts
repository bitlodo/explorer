import { expect, test } from 'bun:test';
import { Color } from 'three';
import { DEFAULT_RENDERING_MODE, DISPLAY_MODES, LAYER_PRESENTATION, regionStyleFor } from '../src/shared/layerPresentation';
import { colorUniforms, paletteColors, setColors } from '../src/map/layers/ParcelSizeColors';

test('Patterns leads the selector and scalar modes retain independent palettes and summary policies', () => {
    expect(DEFAULT_RENDERING_MODE).toBe('patterns');
    expect(DISPLAY_MODES).toEqual(['patterns', 'area', 'size', 'count', 'diversity', 'occupancy']);
    for (const mode of DISPLAY_MODES) {
        expect(LAYER_PRESENTATION[mode].colors).toHaveLength(mode==='patterns'?9:3);
        expect(regionStyleFor(mode)).toBe(mode==='patterns'?'share':'density');
    }
    expect(new Set(DISPLAY_MODES.map(mode => LAYER_PRESENTATION[mode].colors.join(','))).size).toBe(6);
});

test('three anchors preserve endpoints and midpoint across all nine parcel classes', () => {
    const anchors = ['#49099e', '#c03e80', '#ffff00'];
    const colors = paletteColors(anchors);
    expect(colors).toHaveLength(9);
    for (let i = 0; i < 3; i++) expect(colors[i * 4].getHexString()).toBe(anchors[i].slice(1));
    expect(colors[2].toArray()).toEqual(new Color(anchors[0]).lerp(new Color(anchors[1]), .5).toArray());
    const uniforms = colorUniforms();
    setColors(uniforms, anchors);
    expect(uniforms.sizeColors.value.map(c => c.getHexString())).toEqual(colors.map(c => c.getHexString()));
    expect(() => setColors(uniforms, ['invalid', '#ffffff', '#000000'])).toThrow();
});
