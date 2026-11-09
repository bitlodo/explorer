import type { NeighborhoodRect, NeighborhoodSlot } from './NeighborhoodLayout';

type Direction = 0 | 1 | 2 | 3;
type Size = Pick<NeighborhoodRect, 'width' | 'height'>;
type Placement = NeighborhoodRect & { direction: Direction };
type Selection = Placement & { turns: number; gap?: number };
type SpiralSlot = NeighborhoodSlot & { direction: Direction };
type Occupied = { xMin: number; yMin: number; xMax: number; yMax: number };
const SIDES = ['south', 'east', 'north', 'west'] as const;
const nextDirection = (direction: Direction): Direction => ((direction + 1) % 4) as Direction;
const touches = (a: NeighborhoodRect, b: NeighborhoodRect): boolean =>
    (Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
        && (a.y + a.height === b.y || b.y + b.height === a.y))
    || (Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
        && (a.x + a.width === b.x || b.x + b.width === a.x));

/** Internal contour engine used by the two stages of the official v3 rule. */
class Contour {
    slots: SpiralSlot[] = [];
    bounds: NeighborhoodRect = { x: 0, y: 0, width: 0, height: 0 };
    occupied: Occupied = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    direction: Direction = 0;
    turn = 0;

    append({ width, height }: Size): SpiralSlot {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new RangeError('Neighborhood dimensions must be positive finite numbers.');
        }
        if (!this.slots.length) return this.commit({ x: -width / 2, y: -height / 2, width, height, direction: 0 });
        let selected: Selection | undefined;
        let fallback: Selection | undefined;
        const previous = this.slots[this.slots.length - 1]!;
        for (let turns = 0; turns < 4; turns++) {
            const direction = ((this.direction + turns) % 4) as Direction;
            const candidate = this.placeAgainstContour(width, height, direction);
            const overlapX = Math.min(candidate.x + width, previous.x + previous.width) - Math.max(candidate.x, previous.x);
            const overlapY = Math.min(candidate.y + height, previous.y + previous.height) - Math.max(candidate.y, previous.y);
            const gapX = Math.max(0, -overlapX), gapY = Math.max(0, -overlapY);
            const gap = gapX * gapX + gapY * gapY;
            if (!fallback || gap < fallback.gap!) fallback = { ...candidate, turns, gap };
            if (gap === 0 && (overlapX > 0 || overlapY > 0)) {
                selected = { ...candidate, turns }; break;
            }
        }
        const chosen = selected ?? fallback!;
        this.turn += chosen.turns;
        this.direction = chosen.direction;
        return this.commit(chosen);
    }

    protected placeAgainstContour(width: number, height: number, direction: Direction): Placement {
        const previous = this.slots[this.slots.length - 1]!;
        let x: number, y: number;
        if (direction === 0 || direction === 2) {
            y = direction === 0 ? previous.y + previous.height : previous.y - height;
            x = direction === 0 ? previous.x + previous.width - width : previous.x;
            for (const slot of this.slots) {
                if (slot.y >= y + height || slot.y + slot.height <= y) continue;
                x = direction === 0 ? Math.min(x, slot.x - width) : Math.max(x, slot.x + slot.width);
            }
        } else {
            x = direction === 1 ? previous.x + previous.width : previous.x - width;
            y = direction === 1 ? previous.y : previous.y + previous.height - height;
            for (const slot of this.slots) {
                if (slot.x >= x + width || slot.x + slot.width <= x) continue;
                y = direction === 1 ? Math.max(y, slot.y + slot.height) : Math.min(y, slot.y - height);
            }
        }
        return { x, y, width, height, direction };
    }

    protected commit(rect: Placement): SpiralSlot {
        const old = this.occupied, direction = rect.direction;
        const slot: SpiralSlot = { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            direction, crown: Math.floor(this.turn / 4), side: this.slots.length ? SIDES[direction] : 'center' };
        const crossed = this.slots.length > 0 && (direction === 0 ? slot.y + slot.height > old.yMax
            : direction === 1 ? slot.x + slot.width > old.xMax
                : direction === 2 ? slot.y < old.yMin : slot.x < old.xMin);
        this.occupied = this.slots.length ? {
            xMin: Math.min(old.xMin, slot.x), yMin: Math.min(old.yMin, slot.y),
            xMax: Math.max(old.xMax, slot.x + slot.width), yMax: Math.max(old.yMax, slot.y + slot.height),
        } : { xMin: slot.x, yMin: slot.y, xMax: slot.x + slot.width, yMax: slot.y + slot.height };
        const halfWidth = Math.max(-this.occupied.xMin, this.occupied.xMax);
        const halfHeight = Math.max(-this.occupied.yMin, this.occupied.yMax);
        this.bounds = { x: -halfWidth, y: -halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
        this.slots.push(slot);
        if (crossed) { this.direction = nextDirection(direction); this.turn++; }
        return slot;
    }
}

/** V3 route: inward alignment with the full shorter edge kept in contact. */
class InnerEdgeReference extends Contour {
    protected override placeAgainstContour(width: number, height: number, direction: Direction): Placement {
        const candidate = super.placeAgainstContour(width, height, direction);
        const previous = this.slots[this.slots.length - 1]!;
        const vertical = direction === 0 || direction === 2;
        let support = direction === 0 || direction === 3 ? Infinity : -Infinity;
        for (const slot of this.slots) {
            if (vertical) {
                if (slot.y >= candidate.y + height || slot.y + slot.height <= candidate.y) continue;
                support = direction === 0 ? Math.min(support, slot.x - width) : Math.max(support, slot.x + slot.width);
            } else {
                if (slot.x >= candidate.x + width || slot.x + slot.width <= candidate.x) continue;
                support = direction === 1 ? Math.max(support, slot.y + slot.height) : Math.min(support, slot.y - height);
            }
        }
        if (!Number.isFinite(support)) return candidate;
        const contact = Math.min(vertical ? previous.width : previous.height, vertical ? width : height);
        if (direction === 0) candidate.x = Math.min(support, previous.x + previous.width - contact);
        else if (direction === 1) candidate.y = Math.max(support, previous.y - height + contact);
        else if (direction === 2) candidate.x = Math.max(support, previous.x - width + contact);
        else candidate.y = Math.min(support, previous.y + previous.height - contact);
        return candidate;
    }
}

/** The sole neighborhood spiral: exact TypeScript port of Tight v3. */
export default class SpiralLayout extends Contour {
    private readonly reference = new InnerEdgeReference();

    constructor(rects: readonly Size[] = []) {
        super();
        for (const rect of rects) this.append(rect);
    }

    override append(rect: Size): SpiralSlot {
        const anchor = this.reference.append(rect);
        this.turn = anchor.crown * 4 + anchor.direction;
        const closingCorner = this.reference.direction !== anchor.direction;
        const candidate = this.slots.length
            ? this.placeAgainstContour(rect.width, rect.height, anchor.direction, anchor, closingCorner) : anchor;
        const slot = this.commit(candidate);
        this.turn = this.reference.turn;
        this.direction = this.reference.direction;
        return slot;
    }

    protected override placeAgainstContour(width: number, height: number, direction: Direction,
        anchor?: Placement, closingCorner = false): Placement {
        const candidate = anchor ? { ...anchor } : super.placeAgainstContour(width, height, direction);
        const vertical = direction % 2 === 0;
        let support = direction === 0 || direction === 3 ? Infinity : -Infinity;
        for (const slot of this.slots) {
            if (vertical) {
                if (slot.y >= candidate.y + height || slot.y + slot.height <= candidate.y) continue;
                support = direction === 0 ? Math.min(support, slot.x - width) : Math.max(support, slot.x + slot.width);
            } else {
                if (slot.x >= candidate.x + width || slot.x + slot.width <= candidate.x) continue;
                support = direction === 1 ? Math.max(support, slot.y + slot.height) : Math.min(support, slot.y - height);
            }
        }
        if (!Number.isFinite(support)) return this.slots.some(slot => touches(candidate, slot))
            ? candidate : super.placeAgainstContour(width, height, direction);
        // V3 keeps the closing corner on the reference unless an obstacle
        // requires an outward correction. Other pieces follow the inner contour.
        if (direction === 0) candidate.x = closingCorner ? Math.min(candidate.x, support) : support;
        else if (direction === 1) candidate.y = closingCorner ? Math.max(candidate.y, support) : support;
        else if (direction === 2) candidate.x = closingCorner ? Math.max(candidate.x, support) : support;
        else candidate.y = closingCorner ? Math.min(candidate.y, support) : support;
        if (closingCorner && !this.slots.some(slot => touches(candidate, slot))) {
            if (vertical) candidate.x = support;
            else candidate.y = support;
        }
        return candidate;
    }
}
