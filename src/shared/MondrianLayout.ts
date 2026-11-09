// Ordered packing rules adapted from Bitfeed / @mononaut.
export interface MondrianRect { x: number; y: number; width: number; height: number }
export type MondrianInput = Uint8Array | readonly number[] | readonly (readonly [number, number])[];

/** Ordered packing with specialized indices for square sizes and width/height pairs. */
export default class MondrianLayout {
    width = 0;
    height = 0;
    slots: MondrianRect[] = [];
    useRects = false;
    strategy: 'empty' | 'uniform-squares' | 'indexed-squares' | 'indexed-rectangles' = 'empty';

    constructor(input: MondrianInput = []) {
        if (!Array.isArray(input) && !(input instanceof Uint8Array)) throw new TypeError('Expected square sizes or width/height pairs');
        if (!input.length) return;
        this.useRects = Array.isArray(input[0]);
        if (this.useRects) this.rectangles(input as readonly (readonly [number, number])[]);
        else this.squares(input as Uint8Array | readonly number[]);
    }

    getSize() { return { width: this.width, height: this.height }; }

    private squares(sizes: Uint8Array | readonly number[]) {
        let area = 0, uniform = true, maxSize = 0;
        const first = sizes[0];
        for (let i = 0; i < sizes.length; i++) {
            const size = sizes[i];
            if (!Number.isSafeInteger(size) || size <= 0 || size > 65535) throw new RangeError('Square size must be an integer in 1..65535');
            area += size * size;
            maxSize = Math.max(maxSize, size);
            if (size !== first) uniform = false;
        }
        if (!Number.isSafeInteger(area) || area > 1e12) throw new RangeError('Square area exceeds layout budget');
        this.width = Math.ceil(Math.sqrt(area));
        this.slots = new Array<MondrianRect>(sizes.length);
        if (uniform) {
            this.strategy = 'uniform-squares';
            const columns = Math.floor(this.width / first);
            for (let i = 0; i < sizes.length; i++) this.slots[i] = {
                x: i % columns * first, y: Math.floor(i / columns) * first, width: first, height: first,
            };
            this.height = Math.ceil(sizes.length / columns) * first;
            return;
        }
        this.strategy = 'indexed-squares';
        const engine = new SquareIndex(this.width, this.slots, maxSize);
        for (let i = 0; i < sizes.length; i++) engine.place(i, sizes[i]);
        this.width = engine.width; this.height = engine.height;
    }

    private rectangles(rectangles: readonly (readonly [number, number])[]) {
        let area = 0, totalHeight = 0, maxWidth = 0;
        for (const rect of rectangles) {
            if (!Array.isArray(rect) || rect.length !== 2) throw new TypeError('Expected width/height pairs');
            const [w, h] = rect;
            if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) throw new RangeError('Rectangle dimensions must be positive integers');
            area += w * h; totalHeight += h; maxWidth = Math.max(maxWidth, w);
        }
        // Bound per-unit row storage and Int32 coordinates before allocating indices.
        if (!Number.isSafeInteger(area) || area > 1e12 || totalHeight > 1e6 || maxWidth > 1e6) throw new RangeError('Rectangles exceed layout budget');
        this.width = Math.ceil(Math.sqrt(area));
        this.slots = new Array<MondrianRect>(rectangles.length);
        this.strategy = 'indexed-rectangles';
        const engine = new RectangleIndex(this.width, this.slots, maxWidth);
        for (let i = 0; i < rectangles.length; i++) engine.place(i, rectangles[i][0], rectangles[i][1]);
        this.width = engine.width; this.height = engine.height;
    }
}

/**
 * Sparse ordered free intervals. For sizes 1..10, lazy per-size row cursors
 * locate the first viable row; larger domains use a max-width segment tree.
 * Then choose the first interval by X: the original first-fit tie breaking.
 * Node IDs use typed arrays instead of objects, Map, findIndex and splice.
 */
class SquareIndex {
    width: number;
    height = 0;
    private readonly output: MondrianRect[];
    private rows = 0;
    private rowCapacity = 16;
    private heads: Int32Array;
    private tails: Int32Array;
    private dirtyFlags: Uint8Array;
    private tree: Int32Array;
    private rowWidths: Int32Array;
    private firstRows: Int32Array | null;
    private dirtyRows: number[] = [];
    private xs: Int32Array;
    private ys: Int32Array;
    private widths: Int32Array;
    private next: Int32Array;
    private prev: Int32Array;
    private lastNode = 0;
    private reusable: number[] = [];
    private retired: number[] = [];
    private collisions: number[] = [];

    constructor(width: number, output: MondrianRect[], private readonly maxSize: number) {
        this.width = width; this.output = output;
        while (this.rowCapacity < width) this.rowCapacity *= 2;
        this.heads = new Int32Array(this.rowCapacity);
        this.tails = new Int32Array(this.rowCapacity);
        this.dirtyFlags = new Uint8Array(this.rowCapacity);
        this.firstRows = maxSize <= 10 ? new Int32Array(maxSize + 1) : null;
        this.rowWidths = new Int32Array(this.rowCapacity);
        this.tree = new Int32Array(this.firstRows ? 0 : this.rowCapacity * 2);
        const capacity = Math.max(32, Math.min(width, 512));
        this.xs = new Int32Array(capacity); this.ys = new Int32Array(capacity);
        this.widths = new Int32Array(capacity); this.next = new Int32Array(capacity); this.prev = new Int32Array(capacity);
    }

    place(index: number, size: number) {
        let row = this.firstRow(size), slot = 0;
        if (row >= 0) {
            slot = this.heads[row];
            while (slot && this.widths[slot] < size) slot = this.next[slot];
        } else {
            row = this.addRow();
            slot = this.add(row, 0, this.width);
        }
        // Snapshot the anchor: its node may be removed while splitting holes.
        const x = this.xs[slot], y = this.ys[slot], available = this.widths[slot];
        const right = x + size, top = y + size;
        this.remove(slot);
        for (let r = y; r < top; r++) {
            if (r < this.rows) {
                const collisions = this.collisions;
                collisions.length = 0;
                let excess = 0;
                // Intervals are ordered by X; nothing at/after right can collide.
                for (let node = this.heads[r]; node && this.xs[node] < right; node = this.next[node]) {
                    // Preserve the original strict '<' at the left boundary.
                    if (!(this.xs[node] + this.widths[node] < x || this.xs[node] >= right)) {
                        collisions.push(node);
                        excess = Math.max(excess, this.xs[node] + this.widths[node] - (x + available), 0);
                    }
                }
                if (right < this.width && !this.find(r, right)) this.add(r, right, available - size + excess);
                for (let i = 0; i < collisions.length; i++) {
                    const node = collisions[i];
                    this.widths[node] = x - this.xs[node];
                    if (this.widths[node] === 0) this.remove(node);
                    else this.markDirty(r);
                }
            } else {
                this.addRow();
                if (x > 0) this.add(r, 0, x);
                if (right < this.width) this.add(r, right, this.width - right);
            }
        }
        for (let r = Math.max(0, y - size); r < y; r++) {
            // New intervals are inserted after the current X. Following next
            // after splitting reproduces the original mutable-array iteration.
            for (let node = this.heads[r]; node && this.xs[node] < right; node = this.next[node]) {
                if (this.xs[node] < right && this.xs[node] + this.widths[node] > x
                    && this.ys[node] + this.widths[node] >= y && size <= top - r) {
                    const oldWidth = this.widths[node];
                    const cut = y - this.ys[node];
                    this.widths[node] = cut; this.markDirty(r);
                    let remainingX = this.xs[node] + cut, remainingY = this.ys[node];
                    let remainingWidth = oldWidth - cut, remainingHeight = cut;
                    while (remainingWidth > 0 && remainingHeight > 0) {
                        if (remainingWidth <= remainingHeight) {
                            this.add(remainingY, remainingX, remainingWidth);
                            remainingY += remainingWidth; remainingHeight -= remainingWidth;
                        } else {
                            this.add(remainingY, remainingX, remainingHeight);
                            remainingX += remainingHeight; remainingWidth -= remainingHeight;
                        }
                    }
                }
            }
        }
        this.width = Math.max(this.width, right); this.height = Math.max(this.height, top);
        this.output[index] = { x, y, width: size, height: size };
        this.flushDirty();
        // Do not reuse retired IDs inside a placement: anchor/collision references
        // must remain stable until all rows have been processed.
        for (let i = 0; i < this.retired.length; i++) this.reusable.push(this.retired[i]);
        this.retired.length = 0;
    }

    private firstRow(size: number) {
        if (this.firstRows) {
            let row = this.firstRows[size];
            while (row < this.rows && this.rowWidths[row] < size) row++;
            this.firstRows[size] = row;
            return row < this.rows ? row : -1;
        }
        if (this.tree[1] < size) return -1;
        let node = 1;
        while (node < this.rowCapacity) {
            node *= 2;
            if (this.tree[node] < size) node++;
        }
        return node - this.rowCapacity;
    }

    private addRow() {
        if (this.rows === this.rowCapacity) {
            const oldCapacity = this.rowCapacity;
            this.rowCapacity *= 2;
            const heads = new Int32Array(this.rowCapacity); heads.set(this.heads); this.heads = heads;
            const tails = new Int32Array(this.rowCapacity); tails.set(this.tails); this.tails = tails;
            const dirty = new Uint8Array(this.rowCapacity); dirty.set(this.dirtyFlags); this.dirtyFlags = dirty;
            const widths = new Int32Array(this.rowCapacity); widths.set(this.rowWidths); this.rowWidths = widths;
            if (!this.firstRows) {
                const tree = new Int32Array(this.rowCapacity * 2);
                tree.set(this.tree.subarray(oldCapacity), this.rowCapacity);
                for (let i = this.rowCapacity - 1; i; i--) tree[i] = Math.max(tree[i * 2], tree[i * 2 + 1]);
                this.tree = tree;
            }
        }
        return this.rows++;
    }

    private find(row: number, x: number) {
        const tail = this.tails[row];
        if (tail && x >= this.xs[tail]) return x === this.xs[tail] ? tail : 0;
        for (let node = this.heads[row]; node; node = this.next[node]) {
            if (this.xs[node] === x) return node;
            if (this.xs[node] > x) break;
        }
        return 0;
    }

    private add(row: number, x: number, width: number) {
        if (width <= 0 || row >= this.rows) return 0;
        let before = 0, after = this.heads[row];
        const tail = this.tails[row];
        if (tail && this.xs[tail] <= x) { before = tail; after = 0; }
        else while (after && this.xs[after] < x) { before = after; after = this.next[after]; }
        const existing = before && this.xs[before] === x ? before : after && this.xs[after] === x ? after : 0;
        if (existing) {
            this.widths[existing] = Math.max(this.widths[existing], width);
            this.markDirty(row); return existing;
        }
        const node = this.reusable.length ? this.reusable.pop()! : ++this.lastNode;
        if (node === this.xs.length) this.growNodes();
        this.xs[node] = x; this.ys[node] = row; this.widths[node] = width;
        this.prev[node] = before; this.next[node] = after;
        if (before) this.next[before] = node; else this.heads[row] = node;
        if (after) this.prev[after] = node; else this.tails[row] = node;
        this.markDirty(row); return node;
    }

    private remove(node: number) {
        const row = this.ys[node], before = this.prev[node], after = this.next[node];
        if (before) this.next[before] = after; else this.heads[row] = after;
        if (after) this.prev[after] = before; else this.tails[row] = before;
        this.retired.push(node); this.markDirty(row);
    }

    private markDirty(row: number) {
        if (!this.dirtyFlags[row]) { this.dirtyFlags[row] = 1; this.dirtyRows.push(row); }
    }

    private flushDirty() {
        for (let i = 0; i < this.dirtyRows.length; i++) {
            const row = this.dirtyRows[i]; this.dirtyFlags[row] = 0;
            let max = 0;
            for (let node = this.heads[row]; node; node = this.next[node]) {
                max = Math.max(max, this.widths[node]);
                // No query exceeds maxSize. Saturate only the search index, not
                // the actual interval width or any output rectangle.
                if (max >= this.maxSize) { max = this.maxSize; break; }
            }
            if (this.firstRows) {
                const previous = this.rowWidths[row];
                this.rowWidths[row] = max;
                // Only newly eligible sizes can need a backwards cursor move.
                // Removal is lazy: firstRow advances until an eligible row.
                for (let size = previous + 1; size <= max; size++) {
                    if (row < this.firstRows[size]) this.firstRows[size] = row;
                }
                continue;
            }
            let index = this.rowCapacity + row;
            if (this.tree[index] === max) continue;
            this.tree[index] = max;
            while (index > 1) {
                index = Math.floor(index / 2);
                const next = Math.max(this.tree[index * 2], this.tree[index * 2 + 1]);
                if (this.tree[index] === next) break;
                this.tree[index] = next;
            }
        }
        this.dirtyRows.length = 0;
    }

    private growNodes() {
        const capacity = this.xs.length * 2;
        const grow = (old: Int32Array) => { const array = new Int32Array(capacity); array.set(old); return array; };
        this.xs = grow(this.xs); this.ys = grow(this.ys); this.widths = grow(this.widths);
        this.next = grow(this.next); this.prev = grow(this.prev);
    }
}

/**
 * Ordered free intervals in typed arrays, batched max-width row index and pooled
 * IDs, as in the square Fast. Independent rectangle height also requires exact
 * collision queries against previously placed rectangles (BoundsIndex below).
 */
class RectangleIndex {
    width: number;
    height = 0;
    private readonly output: MondrianRect[];
    private rows = 0;
    private rowCapacity = 16;
    private heads: Int32Array;
    private tails: Int32Array;
    private dirtyFlags: Uint8Array;
    private tree: Int32Array;
    private readonly bounds: BoundsIndex;
    private dirtyRows: number[] = [];
    private xs: Int32Array;
    private ys: Int32Array;
    private widths: Int32Array;
    private next: Int32Array;
    private prev: Int32Array;
    private lastNode = 0;
    private reusable: number[] = [];
    private retired: number[] = [];
    private collisions: number[] = [];

    constructor(width: number, output: MondrianRect[], private readonly maxSize: number) {
        this.width = width; this.output = output;
        while (this.rowCapacity < width) this.rowCapacity *= 2;
        this.heads = new Int32Array(this.rowCapacity);
        this.tails = new Int32Array(this.rowCapacity);
        this.dirtyFlags = new Uint8Array(this.rowCapacity);
        this.bounds = new BoundsIndex(output.length);
        this.tree = new Int32Array(this.rowCapacity * 2);
        const capacity = Math.max(32, Math.min(width, 512));
        this.xs = new Int32Array(capacity); this.ys = new Int32Array(capacity);
        this.widths = new Int32Array(capacity); this.next = new Int32Array(capacity); this.prev = new Int32Array(capacity);
    }

    place(index: number, w: number, h: number) {
        let row = this.firstRow(w, 0), slot = 0;
        while (row >= 0 && !slot) {
            for (let node = this.heads[row]; node; node = this.next[node]) {
                if (this.widths[node] >= w && !this.bounds.overlaps(this.xs[node], row, w, h)) {
                    slot = node; break;
                }
            }
            if (!slot) row = this.firstRow(w, row + 1);
        }
        if (!slot) {
            row = this.addRow();
            slot = this.add(row, 0, this.width);
        }
        // Snapshot the anchor: its node may be removed while splitting holes.
        const x = this.xs[slot], y = this.ys[slot], available = this.widths[slot];
        const right = x + w, top = y + h;
        this.remove(slot);
        for (let r = y; r < top; r++) {
            if (r < this.rows) {
                const collisions = this.collisions;
                collisions.length = 0;
                let excess = 0;
                // Intervals are ordered by X; nothing at/after right can collide.
                for (let node = this.heads[r]; node && this.xs[node] < right; node = this.next[node]) {
                    // Preserve the original strict '<' at the left boundary.
                    if (!(this.xs[node] + this.widths[node] < x || this.xs[node] >= right)) {
                        collisions.push(node);
                        excess = Math.max(excess, this.xs[node] + this.widths[node] - (x + available), 0);
                    }
                }
                if (right < this.width && !this.find(r, right)) this.add(r, right, available - w + excess);
                for (let i = 0; i < collisions.length; i++) {
                    const node = collisions[i];
                    this.widths[node] = x - this.xs[node];
                    if (this.widths[node] === 0) this.remove(node);
                    else this.markDirty(r);
                }
            } else {
                this.addRow();
                if (x > 0) this.add(r, 0, x);
                if (right < this.width) this.add(r, right, this.width - right);
            }
        }
        for (let r = Math.max(0, y - h); r < y; r++) {
            // New intervals are inserted after the current X. Following next
            // after splitting reproduces the original mutable-array iteration.
            for (let node = this.heads[r]; node && this.xs[node] < right; node = this.next[node]) {
                if (this.xs[node] < right && this.xs[node] + this.widths[node] > x
                    && this.ys[node] + this.widths[node] >= y && h <= top - r) {
                    const oldWidth = this.widths[node];
                    const cut = y - this.ys[node];
                    this.widths[node] = cut; this.markDirty(r);
                    let remainingX = this.xs[node] + cut, remainingY = this.ys[node];
                    let remainingWidth = oldWidth - cut, remainingHeight = cut;
                    while (remainingWidth > 0 && remainingHeight > 0) {
                        if (remainingWidth <= remainingHeight) {
                            this.add(remainingY, remainingX, remainingWidth);
                            remainingY += remainingWidth; remainingHeight -= remainingWidth;
                        } else {
                            this.add(remainingY, remainingX, remainingHeight);
                            remainingX += remainingHeight; remainingWidth -= remainingHeight;
                        }
                    }
                }
            }
        }
        this.width = Math.max(this.width, right); this.height = Math.max(this.height, top);
        this.output[index] = { x, y, width: w, height: h };
        this.bounds.insert(index, x, y, right, top);
        this.flushDirty();
        // Do not reuse retired IDs inside a placement: anchor/collision references
        // must remain stable until all rows have been processed.
        for (let i = 0; i < this.retired.length; i++) this.reusable.push(this.retired[i]);
        this.retired.length = 0;
    }

    /** First eligible row at or after start. Skip rejected rows without scanning them. */
    private firstRow(width: number, start: number) {
        if (start >= this.rows || this.tree[1] < width) return -1;
        let node = this.rowCapacity + start;
        if (this.tree[node] >= width) return start;
        while (node > 1 && (node % 2 === 1 || this.tree[node + 1] < width)) node = Math.floor(node / 2);
        if (node === 1) return -1;
        node++;
        while (node < this.rowCapacity) {
            node *= 2;
            if (this.tree[node] < width) node++;
        }
        return node - this.rowCapacity;
    }

    private addRow() {
        if (this.rows === this.rowCapacity) {
            const oldCapacity = this.rowCapacity;
            this.rowCapacity *= 2;
            const heads = new Int32Array(this.rowCapacity); heads.set(this.heads); this.heads = heads;
            const tails = new Int32Array(this.rowCapacity); tails.set(this.tails); this.tails = tails;
            const dirty = new Uint8Array(this.rowCapacity); dirty.set(this.dirtyFlags); this.dirtyFlags = dirty;
            const tree = new Int32Array(this.rowCapacity * 2);
            tree.set(this.tree.subarray(oldCapacity), this.rowCapacity);
            for (let i = this.rowCapacity - 1; i; i--) tree[i] = Math.max(tree[i * 2], tree[i * 2 + 1]);
            this.tree = tree;
        }
        return this.rows++;
    }

    private find(row: number, x: number) {
        const tail = this.tails[row];
        if (tail && x >= this.xs[tail]) return x === this.xs[tail] ? tail : 0;
        for (let node = this.heads[row]; node; node = this.next[node]) {
            if (this.xs[node] === x) return node;
            if (this.xs[node] > x) break;
        }
        return 0;
    }

    private add(row: number, x: number, width: number) {
        if (width <= 0 || row >= this.rows) return 0;
        let before = 0, after = this.heads[row];
        const tail = this.tails[row];
        if (tail && this.xs[tail] <= x) { before = tail; after = 0; }
        else while (after && this.xs[after] < x) { before = after; after = this.next[after]; }
        const existing = before && this.xs[before] === x ? before : after && this.xs[after] === x ? after : 0;
        if (existing) {
            this.widths[existing] = Math.max(this.widths[existing], width);
            this.markDirty(row); return existing;
        }
        const node = this.reusable.length ? this.reusable.pop()! : ++this.lastNode;
        if (node === this.xs.length) this.growNodes();
        this.xs[node] = x; this.ys[node] = row; this.widths[node] = width;
        this.prev[node] = before; this.next[node] = after;
        if (before) this.next[before] = node; else this.heads[row] = node;
        if (after) this.prev[after] = node; else this.tails[row] = node;
        this.markDirty(row); return node;
    }

    private remove(node: number) {
        const row = this.ys[node], before = this.prev[node], after = this.next[node];
        if (before) this.next[before] = after; else this.heads[row] = after;
        if (after) this.prev[after] = before; else this.tails[row] = before;
        this.retired.push(node); this.markDirty(row);
    }

    private markDirty(row: number) {
        if (!this.dirtyFlags[row]) { this.dirtyFlags[row] = 1; this.dirtyRows.push(row); }
    }

    private flushDirty() {
        for (let i = 0; i < this.dirtyRows.length; i++) {
            const row = this.dirtyRows[i]; this.dirtyFlags[row] = 0;
            let max = 0;
            for (let node = this.heads[row]; node; node = this.next[node]) {
                max = Math.max(max, this.widths[node]);
                // No query exceeds maxSize. Saturate only the search index, not
                // the actual interval width or any output rectangle.
                if (max >= this.maxSize) { max = this.maxSize; break; }
            }
            let index = this.rowCapacity + row;
            if (this.tree[index] === max) continue;
            this.tree[index] = max;
            while (index > 1) {
                index = Math.floor(index / 2);
                const next = Math.max(this.tree[index * 2], this.tree[index * 2 + 1]);
                if (this.tree[index] === next) break;
                this.tree[index] = next;
            }
        }
        this.dirtyRows.length = 0;
    }

    private growNodes() {
        const capacity = this.xs.length * 2;
        const grow = (old: Int32Array) => { const array = new Int32Array(capacity); array.set(old); return array; };
        this.xs = grow(this.xs); this.ys = grow(this.ys); this.widths = grow(this.widths);
        this.next = grow(this.next); this.prev = grow(this.prev);
    }
}

/**
 * Append-only balanced AABB hierarchy over output IDs. Leaves follow input order;
 * internal boxes only prune candidates, never choose placement or change order.
 * Exact half-open overlap checks replace the original scan of every prior rect.
 */
class BoundsIndex {
    private capacity = 1;
    private readonly left: Int32Array;
    private readonly bottom: Int32Array;
    private readonly right: Int32Array;
    private readonly top: Int32Array;
    private readonly stack: number[] = [];

    constructor(count: number) {
        while (this.capacity < count) this.capacity *= 2;
        const n = this.capacity * 2;
        this.left = new Int32Array(n); this.left.fill(0x7fffffff);
        this.bottom = new Int32Array(n); this.bottom.fill(0x7fffffff);
        this.right = new Int32Array(n); this.top = new Int32Array(n);
    }

    insert(id: number, x: number, y: number, right: number, top: number) {
        let node = this.capacity + id;
        this.left[node] = x; this.bottom[node] = y;
        this.right[node] = right; this.top[node] = top;
        while (node > 1) {
            node = Math.floor(node / 2);
            const a = node * 2, b = a + 1;
            this.left[node] = Math.min(this.left[a], this.left[b]);
            this.bottom[node] = Math.min(this.bottom[a], this.bottom[b]);
            this.right[node] = Math.max(this.right[a], this.right[b]);
            this.top[node] = Math.max(this.top[a], this.top[b]);
        }
    }

    overlaps(x: number, y: number, w: number, h: number) {
        const right = x + w, top = y + h, stack = this.stack;
        stack.length = 0; stack.push(1);
        while (stack.length) {
            const node = stack.pop()!;
            if (this.right[node] <= x || this.left[node] >= right || this.top[node] <= y || this.bottom[node] >= top) continue;
            if (node >= this.capacity) return true;
            stack.push(node * 2 + 1, node * 2);
        }
        return false;
    }
}
