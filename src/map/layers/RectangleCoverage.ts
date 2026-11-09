/** Shader-only filtering; packed rectangles retain their original visual inset. */
export const rectangleCoverageVertexGLSL = `
    uniform float rectangleSmoothing;
    uniform float rectanglePixelsPerWorld;
    varying vec2 vRectanglePosition;
    flat varying vec2 vRectangleExtent;

    vec2 rectanglePosition(vec2 corner, vec2 insetExtent, float margin) {
        // Rasterize the canonical cell so subpixel gaps can lose contrast without
        // moving the cell's origin or overlapping an adjacent cell.
        float filtering = rectangleSmoothing * (1.0 - smoothstep(1.25, 2.0, margin * rectanglePixelsPerWorld));
        vRectangleExtent = insetExtent + vec2(margin);
        float projectedAxis = min(vRectangleExtent.x, vRectangleExtent.y) * rectanglePixelsPerWorld;
        float gapFill = rectangleSmoothing * (1.0 - smoothstep(2.5, 4.5, projectedAxis));
        filtering = max(filtering, gapFill);
        vRectanglePosition = corner * (insetExtent + vec2(margin * filtering));
        return vRectanglePosition;
    }
`;

export const rectangleCoverageFragmentGLSL = `
    uniform float rectangleSmoothing;
    uniform float rectanglePixelsPerWorld;
    varying vec2 vRectanglePosition;
    flat varying vec2 vRectangleExtent;

    // Integral of a repeating axis-aligned fill followed by its trailing gap.
    // Neighboring cells contribute the same gap at a shared edge, so filtering
    // preserves the mean filled area even when a gap is narrower than a pixel.
    vec2 rectangleFillIntegral(vec2 coordinate, vec2 extent, vec2 fill) {
        vec2 cell = floor(coordinate / extent);
        vec2 local = coordinate - cell * extent;
        return cell * fill + min(local, fill);
    }

    float rectangleCoverage(float margin) {
        // Resolved gaps retain the original geometry and native MSAA coverage.
        float filtering = rectangleSmoothing * (1.0 - smoothstep(1.25, 2.0, margin * rectanglePixelsPerWorld));
        if (filtering <= 0.0) return 1.0;
        vec2 footprint = max(fwidth(vRectanglePosition), vec2(0.00001));
        // Average the original fill and gap over the pixel footprint.
        vec2 fill = vRectangleExtent - vec2(margin);
        vec2 coverage = clamp((
            rectangleFillIntegral(vRectanglePosition + footprint * 0.5, vRectangleExtent, fill) -
            rectangleFillIntegral(vRectanglePosition - footprint * 0.5, vRectangleExtent, fill)
        ) / footprint, 0.0, 1.0);
        return mix(1.0, coverage.x * coverage.y, filtering);
    }

    float rectangleDetailCoverage(float margin, float projectedAxis) {
        // Unresolvable visual gaps otherwise alias and accumulate darkness.
        // Use each rectangle's own fill, restoring full gaps when resolved.
        float gapFill = rectangleSmoothing * (1.0 - smoothstep(2.5, 4.5, projectedAxis));
        return mix(rectangleCoverage(margin), 1.0, gapFill);
    }
`;
